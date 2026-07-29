// 把一次 run 的 onDelta 增量喂给 bubble-splitter，并把切分结果落成 Message
// 记录 + 发出 SSE 事件序列（message.created streaming -> message.delta ×N ->
// message.completed），一个 run 产生 N 条 Message 记录。

import { createBubbleSplitter } from "./bubble-splitter.js";
import { newMessageId } from "../core/id.js";
import { touchSpaceUpdatedAt } from "./spaces.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function createBubbleStream({
  store, hub, config, spaceId, spaceSessionId, runId,
  accountId, accountNameSnapshot, executingAgentId, effectiveModel, delegated,
  onMessageCompleted = null,
}) {
  const splitter = createBubbleSplitter(config.bubbles);
  const replyMessageIds = [];
  let current = null;
  let targetOverride = null;
  let agentRouting = "default";

  function acceptsOutput() {
    return store.find("runs", runId)?.status === "running";
  }

  function open(initialContent = "") {
    if (!acceptsOutput()) return false;
    const now = new Date().toISOString();
    const message = {
      id: newMessageId(),
      spaceId,
      spaceSessionId,
      author: { type: "account", accountId },
      accountNameSnapshot,
      executingAgentId,
      effectiveModel,
      delegated,
      target: targetOverride ?? { type: "broadcast" },
      content: initialContent,
      runId,
      status: "streaming",
      createdAt: now,
    };
    const stored = store.insert("messages", message);
    replyMessageIds.push(stored.id);
    hub.publish("message.created", { message: stripInternal(stored) });
    hub.publish("space.updated", { space: touchSpaceUpdatedAt(store, spaceId, now) });
    current = stored;
    if (initialContent) {
      hub.publish("message.delta", { messageId: stored.id, spaceId, spaceSessionId, delta: initialContent });
    }
    return true;
  }

  function close(finalText, status = "completed") {
    if (!current) return;
    const authoritative = store.find("messages", current.id);
    if (!acceptsOutput() || authoritative?.status !== "streaming") {
      current = null;
      return;
    }
    const updated = store.update("messages", current.id, {
      content: finalText,
      status,
    });
    hub.publish("message.completed", { message: stripInternal(updated) });
    if (status === "completed") onMessageCompleted?.(updated, { agentRouting });
    current = null;
  }

  function delta(text) {
    if (!text || !acceptsOutput()) return;
    const completed = splitter.feed(text);

    if (completed.length === 0) {
      if (!current && !open()) return;
      current = store.update("messages", current.id, { content: current.content + text });
      hub.publish("message.delta", { messageId: current.id, spaceId, spaceSessionId, delta: text });
      return;
    }

    if (!current && !open()) return;
    close(completed[0]);
    for (let i = 1; i < completed.length; i += 1) {
      open();
      close(completed[i]);
    }
    const remainder = splitter.peek();
    if (remainder) open(remainder);
  }

  // run 结束（成功/失败/取消）时调用：把剩余未定稿的文本收尾成最后一个气泡，
  // 不留任何 status: "streaming" 的悬空消息。
  // fallbackContent：adapter 允许不调 onDelta 只在返回值里给全文
  // （adapter-interface.md「run() 返回」），零 delta 时用它兜底产气泡。
  function finish(fallbackContent, target = null, nextAgentRouting = "default") {
    if (!acceptsOutput()) {
      current = null;
      return;
    }
    if (target) targetOverride = structuredClone(target);
    agentRouting = nextAgentRouting;
    if (replyMessageIds.length === 0 && !splitter.peek() && fallbackContent) {
      delta(fallbackContent);
    }
    const rest = splitter.flush();
    for (const text of rest) {
      if (!current) open();
      close(text);
    }
  }

  function fail(fallbackContent) {
    if (!acceptsOutput()) {
      current = null;
      return;
    }
    if (replyMessageIds.length === 0 && !splitter.peek() && fallbackContent) {
      delta(fallbackContent);
    }
    const rest = splitter.flush();
    for (const text of rest) {
      if (!current) open();
      close(text, "failed");
    }
    const messageId = replyMessageIds.at(-1);
    const message = messageId ? store.find("messages", messageId) : null;
    if (!message || message.status === "failed") return;
    const updated = store.update("messages", message.id, { status: "failed" });
    hub.publish("message.completed", { message: stripInternal(updated) });
  }

  return {
    delta,
    finish,
    fail,
    get replyMessageIds() {
      return replyMessageIds;
    },
  };
}
