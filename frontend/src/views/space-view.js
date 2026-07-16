import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createTimelineStore } from "../state/timeline-store.js";
import { renderMessageBubble, applyMessageBubble } from "../components/message-bubble.js";
import { renderActivity, applyActivity } from "../components/activity-item.js";
import { renderApprovalCard, applyApprovalCard } from "../components/approval-card.js";
import { createComposer } from "../components/composer.js";
import { attachEdgeSwipe } from "../hooks/edge-swipe.js";
import { createRunStatus } from "../components/run-status.js";
import { createFilesClient, FILE_ACCEPT } from "../api/files-client.js";

const TIMELINE_PAGE_SIZE = 50;
const TIMELINE_DOM_LIMIT = 200;

function keyOf(item) {
  return `${item.itemType}:${item.id}`;
}

function envelopeSpaceId(envelope) {
  const data = envelope?.data;
  return data?.spaceId ?? data?.message?.spaceId ?? data?.activity?.spaceId ?? data?.approval?.spaceId ?? data?.run?.spaceId ?? null;
}

function envelopeSpaceSessionId(envelope) {
  const data = envelope?.data;
  return data?.spaceSessionId ?? data?.message?.spaceSessionId ?? data?.activity?.spaceSessionId
    ?? data?.approval?.spaceSessionId ?? data?.run?.spaceSessionId ?? null;
}

export function mountSpaceView({ root, platform, runtime, spaceId: requestedSpaceId, shell } = {}) {
  let mounted = true;
  let space = null;
  let hydrating = true;
  let hydrationGeneration = 0;
  let pendingEvents = [];
  let hasOlder = true;
  let loadingOlder = false;
  let preserveFullRenderScroll = false;
  let activeCompactionJobId = null;

  root.dataset.routeScope = "chat";

  const statusBar = document.createElement("div");
  statusBar.className = "vera-status-bar";
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("aria-live", "polite");
  statusBar.textContent = "连接中…";
  const setStatus = (message) => {
    statusBar.textContent = message;
    statusBar.hidden = !message;
  };
  const showArchivedStatus = () => {
    setStatus("这个 Space 已归档；可从 Space 导航恢复。");
    const restoreLink = document.createElement("button");
    restoreLink.type = "button";
    restoreLink.className = "vera-text-button";
    restoreLink.textContent = "打开 Space 导航";
    restoreLink.addEventListener("click", () => shell?.openNavigator());
    statusBar.appendChild(restoreLink);
  };
  const timelineEl = document.createElement("div");
  timelineEl.className = "vera-timeline";
  timelineEl.setAttribute("role", "log");
  timelineEl.setAttribute("aria-live", "polite");
  timelineEl.setAttribute("aria-relevant", "additions text");
  timelineEl.setAttribute("aria-label", "Space 消息时间线");
  const olderButton = document.createElement("button");
  olderButton.type = "button";
  olderButton.className = "vera-load-older";
  olderButton.textContent = "加载更早消息";
  olderButton.hidden = true;
  const spaces = createSpacesClient(createHttpClient(platform));
  const files = createFilesClient(createHttpClient(platform));
  const runStatus = createRunStatus({
    onCancel: async (runIds) => {
      try { await Promise.all(runIds.map((runId) => spaces.cancelRun(runId))); }
      catch (err) { setStatus(`取消失败：${err.message}`); }
    },
  });
  root.append(statusBar, olderButton, timelineEl, runStatus.element);
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
        setStatus("这项授权已经失效或被答复。");
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

  function isNearBottom() {
    return timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80;
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
    if (preserveFullRenderScroll) preserveFullRenderScroll = false;
    else scrollToBottom();
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
    const keepLatestVisible = isNearBottom();
    if (existing) applyItem(existing, item);
    else {
      const element = renderItem(item);
      if (!element) return;
      nodeByKey.set(changedKey, element);
      timelineEl.appendChild(element);
    }
    if (keepLatestVisible) scrollToBottom();
  });

  function ingestForCurrentSpace(envelope) {
    if (!space || envelopeSpaceId(envelope) !== space.id) return;
    const eventSessionId = envelopeSpaceSessionId(envelope);
    if (eventSessionId && eventSessionId !== space.activeSpaceSessionId) return;
    store.ingestEvent(envelope);
  }

  async function reloadActiveTimeline() {
    if (!space) return;
    const timeline = await spaces.fetchTimeline(space.id, { limit: TIMELINE_PAGE_SIZE });
    if (!mounted) return;
    if (timeline.spaceSession?.id) space = { ...space, activeSpaceSessionId: timeline.spaceSession.id };
    store.hydrate(timeline.items);
    hasOlder = timeline.items.length === TIMELINE_PAGE_SIZE;
    olderButton.hidden = !hasOlder;
    setStatus(timeline.items.length ? "" : "还没有消息，发一条开始。");
    shell?.setSpace(space);
  }

  async function refreshCompactionStatus() {
    if (!mounted || !space || !activeCompactionJobId) return;
    const expectedJobId = activeCompactionJobId;
    try {
      const { job } = await spaces.fetchCompactionJob(space.id, expectedJobId);
      if (!mounted || activeCompactionJobId !== expectedJobId) return;
      if (["queued", "running"].includes(job.status)) {
        setStatus("正在压缩各 Agent 的上下文…");
        return;
      }
      activeCompactionJobId = null;
      setStatus(job.status === "succeeded" ? "上下文压缩完成。" : "上下文压缩完成，但有 Agent 未成功。");
    } catch (error) {
      if (mounted && activeCompactionJobId === expectedJobId) {
        setStatus(`上下文压缩状态读取失败：${error.message}`);
      }
    }
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
    if (!space && requestedSpaceId) {
      const allSpaces = await spaces.listSpaces({ archived: "all" });
      if (!mounted || generation !== hydrationGeneration) return;
      space = allSpaces.spaces.find((candidate) => candidate.id === requestedSpaceId) ?? null;
    }
    if (!space) {
      store.hydrate([]);
      setStatus(requestedSpaceId ? "Space 不存在。" : "还没有 Space，请先创建一个。");
      composer.setDisabled(true);
      shell?.setSpace(null);
    } else {
      const timeline = await spaces.fetchTimeline(space.id, { limit: TIMELINE_PAGE_SIZE });
      if (!mounted || generation !== hydrationGeneration) return;
      if (timeline.spaceSession?.id) {
        space = { ...space, activeSpaceSessionId: timeline.spaceSession.id };
      }
      store.hydrate(timeline.items);
      hasOlder = timeline.items.length === TIMELINE_PAGE_SIZE;
      olderButton.hidden = !hasOlder;
      if (space.archivedAt) showArchivedStatus();
      else setStatus(timeline.items.length ? "" : "还没有消息，发一条开始。");
      composer.setDisabled(Boolean(space.archivedAt));
      composer.setTargets(bootstrap.agents.filter((agent) => space.seats.some((seat) => seat.agentId === agent.id)));
      shell?.setSpace(space);
      if (!requestedSpaceId && window.location.hash !== `#/spaces/${encodeURIComponent(space.id)}`) {
        window.history.replaceState(null, "", `#/spaces/${encodeURIComponent(space.id)}`);
      }
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
    setStatus(`${prefix}：${err.message}`);
  }

  function handleRuntimeEvent(envelope) {
    if (!mounted) return;
    if (envelope.type === "runtime.degraded") {
      setStatus("连接出现缺口，正在重新同步…");
      return;
    }
    if (envelope.type === "runtime.reset") {
      setStatus("连接重置，重新同步…");
      runStatus.reset();
      void hydrateFromBootstrap(envelope.data.bootstrap, envelope.seq, { clearPending: true }).catch((err) => {
        handleHydrationError("重新同步失败", err);
      });
      return;
    }
    if (envelope.type === "space.updated" && envelope.data?.space?.id === space?.id) {
      space = envelope.data.space;
      shell?.setSpace(space);
      composer.setDisabled(Boolean(space.archivedAt));
      composer.setTargets(runtime.getBootstrap().agents.filter((agent) => space.seats.some((seat) => seat.agentId === agent.id)));
      if (space.archivedAt) showArchivedStatus();
      else setStatus(null);
    }
    if (envelope.type === "space-session.created" && envelope.data?.spaceId === space?.id) {
      space = { ...space, activeSpaceSessionId: envelope.data.spaceSession.id };
      runStatus.reset();
      void reloadActiveTimeline().catch((err) => handleHydrationError("新对话加载失败", err));
      return;
    }
    if (envelope.type === "agent-session.compaction.updated" &&
        envelope.data?.spaceId === space?.id && envelope.data?.jobId === activeCompactionJobId) {
      void refreshCompactionStatus();
      return;
    }
    if (["file.updated", "file.deleted"].includes(envelope.type)) {
      void reloadActiveTimeline().catch((err) => handleHydrationError("附件状态刷新失败", err));
      return;
    }
    runStatus.handleEvent(envelope, space?.id);
    if (hydrating) pendingEvents.push(envelope);
    else ingestForCurrentSpace(envelope);
  }

  const bootstrap = runtime.getBootstrap();
  const initialSpace = requestedSpaceId
    ? bootstrap.spaces.find((candidate) => candidate.id === requestedSpaceId)
    : bootstrap.spaces[0];
  const composer = createComposer({
    targets: bootstrap.agents.filter((agent) => initialSpace?.seats.some((seat) => seat.agentId === agent.id)),
    onPickAttachment: async () => {
      if (!space) throw new Error("当前没有可上传附件的 Space");
      const selection = await platform.pickFile({ accept: FILE_ACCEPT });
      if (selection?.unsupported) return null;
      const response = await files.upload(space.id, selection);
      return response.file;
    },
    onSend: async (content, target, fileIds) => {
      if (!space) throw new Error("当前没有可发送消息的 Space");
      if (content === "/new") {
        const result = await spaces.startNewSession(space.id, crypto.randomUUID());
        space = { ...space, activeSpaceSessionId: result.newSession.id };
        await reloadActiveTimeline();
        return;
      }
      if (content === "/compact") {
        const { job } = await spaces.compactSession(space.id, crypto.randomUUID());
        activeCompactionJobId = job.id;
        setStatus("正在压缩各 Agent 的上下文…");
        void refreshCompactionStatus();
        return;
      }
      await spaces.postMessage(space.id, {
        author: { type: "user" },
        target,
        content,
        fileIds,
      });
    },
  });
  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent, { since: bootstrap.seq });
  for (const state of bootstrap.agentStates ?? []) {
    runStatus.handleEvent({ type: "agent.state.updated", data: { agentState: state } }, initialSpace?.id);
  }
  root.appendChild(composer.element);

  olderButton.addEventListener("click", async () => {
    if (!space || !hasOlder || loadingOlder) return;
    const oldest = store.getOrderedItems()[0];
    if (!oldest) return;
    loadingOlder = true;
    olderButton.disabled = true;
    const beforeHeight = timelineEl.scrollHeight;
    const beforeTop = timelineEl.scrollTop;
    try {
      const page = await spaces.fetchTimeline(space.id, { before: oldest.id, limit: TIMELINE_PAGE_SIZE });
      preserveFullRenderScroll = true;
      store.prependOlder(page.items);
      hasOlder = page.items.length === TIMELINE_PAGE_SIZE;
      olderButton.hidden = !hasOlder;
      timelineEl.scrollTop = beforeTop + timelineEl.scrollHeight - beforeHeight;
    } catch (err) {
      setStatus(`更早消息加载失败：${err.message}`);
    } finally {
      loadingOlder = false;
      olderButton.disabled = false;
    }
  });

  const detachEdgeSwipe = attachEdgeSwipe(root, () => shell?.openNavigator());

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
    detachEdgeSwipe();
    nodeByKey.clear();
    root.replaceChildren();
    delete root.dataset.routeScope;
  };
}
