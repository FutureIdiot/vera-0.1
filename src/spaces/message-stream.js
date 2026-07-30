// Projects one provider assistant Message into one persisted Vera Message.
// Streaming deltas only grow the current Message; paragraph and Markdown
// boundaries remain content. A new Message is opened only after the adapter
// explicitly completes the previous provider Message.

import { newMessageId } from "../core/id.js";
import { touchSpaceUpdatedAt } from "./spaces.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function createMessageStream({
  store, hub, spaceId, spaceSessionId, runId,
  accountId, accountNameSnapshot, executingAgentId, effectiveModel, delegated,
  onMessageCompleted = null,
}) {
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
    const stored = store.insert("messages", {
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
    });
    replyMessageIds.push(stored.id);
    hub.publish("message.created", { message: stripInternal(stored) });
    hub.publish("space.updated", { space: touchSpaceUpdatedAt(store, spaceId, now) });
    current = stored;
    if (initialContent) {
      hub.publish("message.delta", {
        messageId: stored.id,
        spaceId,
        spaceSessionId,
        delta: initialContent,
      });
    }
    return true;
  }

  function close(status = "completed", finalContent = null) {
    if (!current) return null;
    const authoritative = store.find("messages", current.id);
    if (!acceptsOutput() || authoritative?.status !== "streaming") {
      current = null;
      return null;
    }
    const patch = {
      content: typeof finalContent === "string" ? finalContent : authoritative.content,
      status,
    };
    if (targetOverride) patch.target = structuredClone(targetOverride);
    const updated = store.update("messages", current.id, patch);
    hub.publish("message.completed", { message: stripInternal(updated) });
    if (status === "completed") onMessageCompleted?.(updated, { agentRouting });
    current = null;
    targetOverride = null;
    agentRouting = "default";
    return updated;
  }

  function delta(text) {
    if (!text || !acceptsOutput()) return;
    if (!current && !open()) return;
    current = store.update("messages", current.id, {
      content: `${current.content}${text}`,
    });
    hub.publish("message.delta", {
      messageId: current.id,
      spaceId,
      spaceSessionId,
      delta: text,
    });
  }

  // Completes the current provider Message. If the adapter did not stream,
  // content creates the complete fallback Message. A later complete() call
  // therefore represents a real next provider Message.
  function complete(content, target = null, nextAgentRouting = "default") {
    if (!acceptsOutput()) {
      current = null;
      return null;
    }
    targetOverride = target ? structuredClone(target) : null;
    agentRouting = nextAgentRouting;
    if (!current && typeof content === "string" && content) open(content);
    return close("completed", typeof content === "string" ? content : null);
  }

  function finish(fallbackContent) {
    if (!acceptsOutput()) {
      current = null;
      return;
    }
    if (current) {
      close();
      return;
    }
    if (replyMessageIds.length === 0 && fallbackContent) {
      open(fallbackContent);
      close();
    }
  }

  function fail(fallbackContent) {
    if (!acceptsOutput()) {
      current = null;
      return;
    }
    if (!current && replyMessageIds.length === 0 && fallbackContent) open(fallbackContent);
    if (current) {
      close("failed");
      return;
    }
    const messageId = replyMessageIds.at(-1);
    const message = messageId ? store.find("messages", messageId) : null;
    if (!message || message.status === "failed") return;
    const updated = store.update("messages", message.id, { status: "failed" });
    hub.publish("message.completed", { message: stripInternal(updated) });
  }

  return {
    delta,
    complete,
    finish,
    fail,
    get replyMessageIds() {
      return replyMessageIds;
    },
  };
}
