import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createTimelineStore } from "../state/timeline-store.js";
import { renderMessageBubble, applyMessageBubble } from "../components/message-bubble.js";
import { renderActivity, applyActivity } from "../components/activity-item.js";
import { renderApprovalCard, applyApprovalCard } from "../components/approval-card.js";
import { createComposer } from "../components/composer.js";

const TIMELINE_PAGE_SIZE = 50;
const TIMELINE_DOM_LIMIT = 200;

function keyOf(item) {
  return `${item.itemType}:${item.id}`;
}

function envelopeSpaceId(envelope) {
  const data = envelope?.data;
  return data?.spaceId ?? data?.message?.spaceId ?? data?.activity?.spaceId ?? data?.approval?.spaceId ?? null;
}

export function mountSpaceView({ root, platform, runtime, spaceId: requestedSpaceId } = {}) {
  let mounted = true;
  let space = null;
  let hydrating = true;
  let hydrationGeneration = 0;
  let pendingEvents = [];

  root.dataset.routeScope = "chat";

  const statusBar = document.createElement("div");
  statusBar.className = "vera-status-bar";
  statusBar.textContent = "连接中…";
  const timelineEl = document.createElement("div");
  timelineEl.className = "vera-timeline";
  root.append(statusBar, timelineEl);

  const spaces = createSpacesClient(createHttpClient(platform));
  const store = createTimelineStore({ maxItems: TIMELINE_DOM_LIMIT });
  const nodeByKey = new Map();
  const agentNameById = new Map();
  const bubbleCtx = { agentName: (id) => agentNameById.get(id) };

  async function handleAnswer(approvalId, answer) {
    try {
      await spaces.answerApproval(approvalId, answer);
    } catch (err) {
      if (err.status === 409) {
        const approval = store.getOrderedItems().find((item) => item.itemType === "approval" && item.id === approvalId);
        if (approval) {
          store.ingestEvent({
            type: "approval.answered",
            data: { approval: { ...approval, status: "stale", answer: null } },
          });
        }
        statusBar.textContent = "这项授权已经失效或被答复。";
      }
      throw err;
    }
  }

  function renderItem(item) {
    if (item.itemType === "message") return renderMessageBubble(item, bubbleCtx);
    if (item.itemType === "activity") return renderActivity(item);
    if (item.itemType === "approval") return renderApprovalCard(item, { onAnswer: handleAnswer });
    return null;
  }

  function applyItem(element, item) {
    if (item.itemType === "message") return applyMessageBubble(element, item, bubbleCtx);
    if (item.itemType === "activity") return applyActivity(element, item);
    if (item.itemType === "approval") return applyApprovalCard(element, item, { onAnswer: handleAnswer });
  }

  function scrollToBottom() {
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  function fullRender(items) {
    timelineEl.replaceChildren();
    nodeByKey.clear();
    for (const item of items) {
      const element = renderItem(item);
      if (!element) continue;
      nodeByKey.set(keyOf(item), element);
      timelineEl.appendChild(element);
    }
    scrollToBottom();
  }

  const unsubscribeStore = store.subscribe((items, changedKey, removedKeys) => {
    if (!mounted) return;
    for (const removedKey of removedKeys) {
      nodeByKey.get(removedKey)?.remove();
      nodeByKey.delete(removedKey);
    }
    if (changedKey === null) {
      fullRender(items);
      return;
    }
    const item = items.find((candidate) => keyOf(candidate) === changedKey);
    if (!item) return;
    const existing = nodeByKey.get(changedKey);
    if (existing) applyItem(existing, item);
    else {
      const element = renderItem(item);
      if (!element) return;
      nodeByKey.set(changedKey, element);
      timelineEl.appendChild(element);
    }
    scrollToBottom();
  });

  function ingestForCurrentSpace(envelope) {
    if (!space || envelopeSpaceId(envelope) !== space.id) return;
    store.ingestEvent(envelope);
  }

  async function hydrateFromBootstrap(bootstrap, baselineSeq, { clearPending = false } = {}) {
    const generation = ++hydrationGeneration;
    hydrating = true;
    if (clearPending) pendingEvents = [];
    agentNameById.clear();
    for (const agent of bootstrap.agents ?? []) agentNameById.set(agent.id, agent.name);
    space = requestedSpaceId
      ? bootstrap.spaces.find((candidate) => candidate.id === requestedSpaceId) ?? null
      : bootstrap.spaces[0] ?? null;
    if (!space) {
      store.hydrate([]);
      statusBar.textContent = requestedSpaceId ? "Space 不存在或已归档。" : "还没有 Space，请先创建一个。";
    } else {
      const timeline = await spaces.fetchTimeline(space.id, { limit: TIMELINE_PAGE_SIZE });
      if (!mounted || generation !== hydrationGeneration) return;
      store.hydrate(timeline.items);
      statusBar.textContent = `Space: ${space.name}`;
    }
    if (!mounted || generation !== hydrationGeneration) return;
    const queued = pendingEvents.filter((envelope) => envelope.seq > baselineSeq);
    pendingEvents = [];
    hydrating = false;
    for (const envelope of queued) ingestForCurrentSpace(envelope);
  }

  function handleHydrationError(prefix, err) {
    if (!mounted) return;
    hydrating = false;
    pendingEvents = [];
    statusBar.textContent = `${prefix}：${err.message}`;
  }

  function handleRuntimeEvent(envelope) {
    if (!mounted) return;
    if (envelope.type === "runtime.degraded") {
      statusBar.textContent = "连接出现缺口，正在重新同步…";
      return;
    }
    if (envelope.type === "runtime.reset") {
      statusBar.textContent = "连接重置，重新同步…";
      void hydrateFromBootstrap(envelope.data.bootstrap, envelope.seq, { clearPending: true }).catch((err) => {
        handleHydrationError("重新同步失败", err);
      });
      return;
    }
    if (hydrating) pendingEvents.push(envelope);
    else ingestForCurrentSpace(envelope);
  }

  const bootstrap = runtime.getBootstrap();
  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent, { since: bootstrap.seq });
  const composer = createComposer({
    onSend: async (content) => {
      if (!space) throw new Error("当前没有可发送消息的 Space");
      await spaces.postMessage(space.id, {
        author: { type: "user" },
        target: { type: "broadcast" },
        content,
      });
    },
  });
  root.appendChild(composer.element);

  void hydrateFromBootstrap(bootstrap, bootstrap.seq).catch((err) => {
    handleHydrationError("加载时间线失败", err);
  });

  return function unmountSpaceView() {
    if (!mounted) return;
    mounted = false;
    hydrationGeneration += 1;
    pendingEvents = [];
    unsubscribeRuntime();
    unsubscribeStore();
    nodeByKey.clear();
    root.replaceChildren();
    delete root.dataset.routeScope;
  };
}
