// Run 控制器：一次 agent 响应的完整执行——调用 adapter，把 onDelta 流切成
// 多气泡，发出契约规定的 SSE 事件序列（run.started -> activity/message 序列 ->
// run.ended），并驱动 approval 的请求/过期。
//
// executeRun 同步创建并返回 Run 记录（status: "running"），实际 adapter 调用
// 在内部异步执行（fire-and-forget），这样 POST /api/spaces/:id/messages 可以
// 立即在响应体里带上创建出的 runs，后续进展全部走 SSE
// （api-contract.md 三、发消息 一节）。

import { newRunId, newActivityId } from "../core/id.js";
import { AdapterError } from "../core/errors.js";
import { createBubbleStream } from "./bubble-stream.js";
import { requestApproval as requestApprovalRecord, expirePendingApprovalsForRun } from "./approvals.js";

const abortControllers = new Map(); // runId -> AbortController

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function truncate(text, maxLength) {
  if (typeof text !== "string" || text.length <= maxLength) return text ?? null;
  return `${text.slice(0, maxLength)}\n…(输出截断)`;
}

// POST /api/runs/:id/cancel 用。返回是否找到了在飞的 run。
export function cancelRun(runId) {
  const controller = abortControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function executeRun({ store, hub, config, agent, space, triggerMessage, adapter, agentStates }) {
  const spaceId = space.id;
  const run = {
    id: newRunId(),
    agentId: agent.id,
    spaceId,
    triggerMessageId: triggerMessage.id,
    replyMessageIds: [],
    status: "running",
    createdAt: new Date().toISOString(),
    endedAt: null,
  };
  const storedRun = store.insert("runs", run);
  hub.publish("run.started", { run: stripInternal(storedRun) });
  agentStates?.setWorking(agent.id, spaceId);

  const controller = new AbortController();
  abortControllers.set(storedRun.id, controller);

  // 真正的 adapter 交互异步跑，不阻塞 HTTP 响应。
  void runAsync();

  async function runAsync() {
    const bubbles = createBubbleStream({ store, hub, config, spaceId, runId: storedRun.id, agentId: agent.id });
    const activityIndex = new Map(); // callId -> activity id

    function onActivity(evt) {
      const detail = truncate(evt?.detail, config.activity.detailMaxLength);
      if (evt?.callId && activityIndex.has(evt.callId)) {
        const activityId = activityIndex.get(evt.callId);
        const updated = store.update("activities", activityId, {
          phase: evt.phase,
          label: evt.label,
          detail,
          toolStatus: evt.toolStatus ?? null,
          updatedAt: new Date().toISOString(),
        });
        hub.publish("activity.updated", { activity: stripInternal(updated) });
        return;
      }
      const now = new Date().toISOString();
      const activity = {
        id: newActivityId(),
        spaceId,
        runId: storedRun.id,
        agentId: agent.id,
        phase: evt?.phase,
        label: evt?.label,
        detail,
        toolStatus: evt?.toolStatus ?? null,
        createdAt: now,
        updatedAt: now,
      };
      const stored = store.insert("activities", activity);
      if (evt?.callId) activityIndex.set(evt.callId, stored.id);
      hub.publish("activity.created", { activity: stripInternal(stored) });
    }

    function requestApproval(req) {
      return requestApprovalRecord({ store, hub, spaceId, runId: storedRun.id, agentId: agent.id, req });
    }

    const ctx = {
      agent,
      prompt: { text: triggerMessage.content },
      sessionState: store.getSessionState(agent.id, spaceId),
      workspacePath: process.cwd(),
      onDelta: (text) => bubbles.delta(text),
      onActivity,
      requestApproval,
      signal: controller.signal,
    };

    let status = "completed";
    let error = null;
    try {
      const result = await adapter.run(ctx);
      bubbles.finish(result?.content);
      store.setSessionState(agent.id, spaceId, result?.sessionState ?? null);
    } catch (err) {
      bubbles.finish();
      if (err instanceof AdapterError) {
        status = err.code === "cancelled" ? "cancelled" : "failed";
        error = { code: err.code, message: err.message };
      } else {
        status = "failed";
        error = { code: "internal", message: err?.message ?? "unknown error" };
      }
    } finally {
      abortControllers.delete(storedRun.id);
      expirePendingApprovalsForRun(store, hub, storedRun.id);
      agentStates?.setIdle(agent.id);
      const patch = {
        status,
        endedAt: new Date().toISOString(),
        replyMessageIds: bubbles.replyMessageIds,
      };
      if (error) patch.error = error;
      const updatedRun = store.update("runs", storedRun.id, patch);
      hub.publish("run.ended", { run: stripInternal(updatedRun) });
    }
  }

  return stripInternal(storedRun);
}
