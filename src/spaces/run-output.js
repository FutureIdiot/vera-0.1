import { newActivityId } from "../core/id.js";
import { requestApproval } from "./approvals.js";
import { createBubbleStream } from "./bubble-stream.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function truncate(text, maxLength) {
  if (typeof text !== "string" || text.length <= maxLength) return text ?? null;
  return `${text.slice(0, maxLength)}\n…(输出截断)`;
}

export function createRunOutput({
  store, hub, config, spaceId, spaceSessionId, runId, agent, account, effectiveModel, delegated,
}) {
  const bubbles = createBubbleStream({
    store,
    hub,
    config,
    spaceId,
    spaceSessionId,
    runId,
    accountId: account.id,
    accountNameSnapshot: account.name,
    executingAgentId: agent.id,
    effectiveModel,
    delegated,
  });
  const activityIndex = new Map();

  function onActivity(event) {
    const detail = truncate(event?.detail, config.activity.detailMaxLength);
    if (event?.callId && activityIndex.has(event.callId)) {
      const updated = store.update("activities", activityIndex.get(event.callId), {
        phase: event.phase,
        label: event.label,
        detail,
        toolStatus: event.toolStatus ?? null,
        updatedAt: new Date().toISOString(),
      });
      hub.publish("activity.updated", { activity: stripInternal(updated) });
      return;
    }
    const timestamp = new Date().toISOString();
    const activity = store.insert("activities", {
      id: newActivityId(),
      spaceId,
      spaceSessionId,
      runId,
      agentId: agent.id,
      phase: event?.phase,
      label: event?.label,
      detail,
      toolStatus: event?.toolStatus ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    if (event?.callId) activityIndex.set(event.callId, activity.id);
    hub.publish("activity.created", { activity: stripInternal(activity) });
  }

  return {
    bubbles,
    onActivity,
    requestApproval: (req) => requestApproval({
      store,
      hub,
      spaceId,
      spaceSessionId,
      runId,
      agentId: agent.id,
      req,
    }),
  };
}
