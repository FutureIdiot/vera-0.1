import { createHttpClient } from "../api/http-client.js";
import { createSpacesClient } from "../api/spaces-client.js";
import { createTimelineStore } from "../state/timeline-store.js";
import {
  renderMessageBubble,
  applyMessageBubble,
  resolveMessageGrouping,
} from "../components/message-bubble.js";
import { renderActivity, applyActivity } from "../components/activity-item.js";
import { renderApprovalCard, applyApprovalCard } from "../components/approval-card.js";
import { createComposer } from "../components/composer.js";
import { createRunProgress } from "../components/run-progress.js";
import { createFilesClient, FILE_ACCEPT } from "../api/files-client.js";
import { timelineItemsMatch } from "../state/timeline-cache.js";

const TIMELINE_PAGE_SIZE = 50;
const TIMELINE_DOM_LIMIT = 200;
const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

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

export function mountSpaceView({
  root,
  platform,
  runtime,
  spaceId: requestedSpaceId,
  shell,
  space: projectedSpace = null,
  timelineCache = null,
} = {}) {
  let mounted = true;
  let space = null;
  let hydrating = true;
  let hydrationGeneration = 0;
  let pendingEvents = [];
  let hasOlder = true;
  let loadingOlder = false;
  let preserveFullRenderScroll = false;
  let activeCompactionJobId = null;
  let observation = null;
  let latestSeq = 0;

  root.dataset.routeScope = "chat";

  const statusBar = document.createElement("div");
  statusBar.className = "vera-status-bar";
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("aria-live", "polite");
  statusBar.hidden = true;
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
  const accountNameById = new Map();
  let composer = null;
  let runProgress = null;
  async function backgroundRun(runId) {
    const result = await spaces.backgroundRun(runId);
    runProgress?.handleEvent({ type: "run.backgrounded", data: { run: result.run } });
    return result;
  }
  async function cancelActiveRun(runId) {
    const result = await spaces.cancelRun(runId);
    runProgress?.handleEvent({ type: "run.ended", data: { run: result.run } });
    return result;
  }
  runProgress = createRunProgress({
    accountName: (id) => accountNameById.get(id),
    onBackground: backgroundRun,
    onError: (err) => setStatus(`Run操作失败：${err.message}`),
    onRunsChanged: (runs) => {
      composer?.setForegroundRuns(runs, { isGroupChat: (space?.seats?.length ?? 0) > 1 });
      refreshAllMessageBubbles();
    },
  });
  root.append(statusBar, olderButton, timelineEl);
  const store = createTimelineStore({ maxItems: TIMELINE_DOM_LIMIT });
  const nodeByKey = new Map();
  const bubbleCtx = { accountName: (id) => accountNameById.get(id) };
  const messageContext = (items, index) => {
    const isGroupChat = (space?.seats?.length ?? 0) > 1;
    const item = items[index];
    const latestForRun = item?.runId && !items.slice(index + 1).some((candidate) =>
      candidate.itemType === "message" && candidate.runId === item.runId);
    const runAction = latestForRun ? runProgress.actionForRun(item.runId) : null;
    return {
      ...bubbleCtx,
      isGroupChat,
      grouping: resolveMessageGrouping(items, index, { isGroupChat }),
      workStatus: latestForRun ? runProgress.statusForRun(item.runId) : "",
      onActionError: (error) => setStatus(`Run操作失败：${error.message}`),
      ...(runAction?.kind === "background"
        ? { onBackground: () => backgroundRun(runAction.run.id) }
        : {}),
      ...(runAction?.kind === "stop"
        ? { onStop: () => cancelActiveRun(runAction.run.id) }
        : {}),
    };
  };
  const activityContext = () => ({
    canExpand: (space?.seats?.length ?? 0) === 1 && observation?.observedSpaceId === space?.id,
  });

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

  function renderItem(item, items, index) {
    if (item.itemType === "message") return renderMessageBubble(item, messageContext(items, index));
    if (item.itemType === "activity") return renderActivity(item, activityContext());
    if (item.itemType === "approval") return renderApprovalCard(item, { onAnswer: handleAnswer });
    return null;
  }

  function applyItem(element, item, items, index) {
    if (item.itemType === "message") return applyMessageBubble(element, item, messageContext(items, index));
    if (item.itemType === "activity") return applyActivity(element, item, activityContext());
    if (item.itemType === "approval") return applyApprovalCard(element, item, { onAnswer: handleAnswer });
  }

  function refreshMessageBubble(items, index) {
    const item = items[index];
    if (item?.itemType !== "message") return;
    const element = nodeByKey.get(keyOf(item));
    if (element) applyMessageBubble(element, item, messageContext(items, index));
  }

  function refreshAllMessageBubbles(items = store.getOrderedItems()) {
    for (let index = 0; index < items.length; index += 1) {
      refreshMessageBubble(items, index);
    }
  }

  function refreshAllActivities(items = store.getOrderedItems()) {
    for (const item of items) {
      if (item.itemType !== "activity") continue;
      const element = nodeByKey.get(keyOf(item));
      if (element) applyActivity(element, item, activityContext());
    }
  }

  function isNearBottom() {
    return timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80;
  }

  function scrollToBottom() {
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  function animateNewMessageBubble(element, item) {
    if (item.author?.type !== "account") return;
    element.classList.add("vera-bubble--entering");
    element.addEventListener("animationend", () => {
      element.classList.remove("vera-bubble--entering");
    }, { once: true });
  }

  function fullRender(items) {
    timelineEl.replaceChildren();
    nodeByKey.clear();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const element = renderItem(item, items, index);
      if (!element) continue;
      nodeByKey.set(keyOf(item), element);
      timelineEl.appendChild(element);
    }
    runProgress.attach(timelineEl);
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
    const itemIndex = items.indexOf(item);
    const existing = nodeByKey.get(changedKey);
    const keepLatestVisible = isNearBottom();
    if (existing) applyItem(existing, item, items, itemIndex);
    else {
      const element = renderItem(item, items, itemIndex);
      if (!element) return;
      nodeByKey.set(changedKey, element);
      if (item.itemType === "message") animateNewMessageBubble(element, item);
      timelineEl.appendChild(element);
    }
    if (removedKeys.length) refreshAllMessageBubbles(items);
    else if (!existing && item.itemType === "message") {
      refreshMessageBubble(items, itemIndex - 1);
      refreshMessageBubble(items, itemIndex);
      refreshMessageBubble(items, itemIndex + 1);
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
    runProgress.setContext({
      spaceId: space.id,
      spaceSessionId: space.activeSpaceSessionId,
      isGroupChat: space.seats.length > 1,
    });
    store.hydrate(timeline.items);
    runProgress.hydrate({
      runs: timeline.runs,
      agentStates: runtime.getBootstrap().agentStates,
      messageRunIds: timeline.items.filter((item) => item.itemType === "message").map((item) => item.runId).filter(Boolean),
    });
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
    observation = bootstrap.observation ?? null;
    accountNameById.clear();
    for (const account of bootstrap.accounts ?? []) accountNameById.set(account.id, account.name);
    space = requestedSpaceId
      ? bootstrap.spaces.find((candidate) => candidate.id === requestedSpaceId) ?? null
      : bootstrap.spaces[0] ?? null;
    if (!space && requestedSpaceId) {
      const allSpaces = await spaces.listSpaces({ archived: "all" });
      if (!mounted || generation !== hydrationGeneration) return;
      space = allSpaces.spaces.find((candidate) => candidate.id === requestedSpaceId) ?? null;
    }
    if (!space) {
      runProgress.setContext({ spaceId: null, spaceSessionId: null });
      store.hydrate([]);
      setStatus(requestedSpaceId ? "Space 不存在。" : "还没有 Space，请先创建一个。");
      composer.setDisabled(true);
      shell?.setSpace(null);
    } else {
      runProgress.setContext({
        spaceId: space.id,
        spaceSessionId: space.activeSpaceSessionId,
        isGroupChat: space.seats.length > 1,
      });
      const timeline = await spaces.fetchTimeline(space.id, { limit: TIMELINE_PAGE_SIZE });
      if (!mounted || generation !== hydrationGeneration) return;
      if (timeline.spaceSession?.id) {
        space = { ...space, activeSpaceSessionId: timeline.spaceSession.id };
      }
      runProgress.setContext({
        spaceId: space.id,
        spaceSessionId: space.activeSpaceSessionId,
        isGroupChat: space.seats.length > 1,
      });
      if (!timelineItemsMatch(store.getOrderedItems(), timeline.items)) {
        store.hydrate(timeline.items);
      }
      runProgress.hydrate({
        runs: timeline.runs,
        agentStates: bootstrap.agentStates,
        messageRunIds: timeline.items.filter((item) => item.itemType === "message").map((item) => item.runId).filter(Boolean),
      });
      hasOlder = timeline.items.length === TIMELINE_PAGE_SIZE;
      olderButton.hidden = !hasOlder;
      if (space.archivedAt) showArchivedStatus();
      else setStatus(timeline.items.length ? "" : "还没有消息，发一条开始。");
      composer.setDisabled(Boolean(space.archivedAt));
      composer.setTargets(bootstrap.accounts.filter((account) => space.seats.some((seat) => seat.accountId === account.id)));
      shell?.setSpace(space);
      if (!requestedSpaceId && window.location.hash !== `#/spaces/${encodeURIComponent(space.id)}`) {
        window.history.replaceState(null, "", `#/spaces/${encodeURIComponent(space.id)}`);
      }
    }
    if (!mounted || generation !== hydrationGeneration) return;
    const queued = pendingEvents.filter((envelope) => envelope.seq > baselineSeq);
    pendingEvents = [];
    hydrating = false;
    for (const envelope of queued) {
      runProgress.handleEvent(envelope);
      ingestForCurrentSpace(envelope);
    }
  }

  function handleHydrationError(prefix, err) {
    if (!mounted) return;
    hydrating = false;
    pendingEvents = [];
    setStatus(`${prefix}：${err.message}`);
  }

  function handleRuntimeEvent(envelope) {
    if (!mounted) return;
    if (Number.isFinite(envelope.seq)) latestSeq = Math.max(latestSeq, envelope.seq);
    if (envelope.type === "runtime.degraded") {
      setStatus("连接出现缺口，正在重新同步…");
      return;
    }
    if (envelope.type === "runtime.reset") {
      setStatus("连接重置，重新同步…");
      runProgress.reset();
      void hydrateFromBootstrap(envelope.data.bootstrap, envelope.seq, { clearPending: true }).catch((err) => {
        handleHydrationError("重新同步失败", err);
      });
      return;
    }
    if (envelope.type === "space.updated" && envelope.data?.space?.id === space?.id) {
      space = envelope.data.space;
      runProgress.setContext({
        spaceId: space.id,
        spaceSessionId: space.activeSpaceSessionId,
        isGroupChat: space.seats.length > 1,
      });
      shell?.setSpace(space);
      composer.setDisabled(Boolean(space.archivedAt));
      composer.setTargets(runtime.getBootstrap().accounts.filter((account) => space.seats.some((seat) => seat.accountId === account.id)));
      refreshAllMessageBubbles();
      refreshAllActivities();
      if (space.archivedAt) showArchivedStatus();
      else setStatus(null);
    }
    if (envelope.type === "observation.updated" && envelope.data?.observation) {
      observation = envelope.data.observation;
      refreshAllActivities();
      void reloadActiveTimeline().catch((err) => handleHydrationError("过程可见性刷新失败", err));
      return;
    }
    if (envelope.type === "space-session.created" && envelope.data?.spaceId === space?.id) {
      space = { ...space, activeSpaceSessionId: envelope.data.spaceSession.id };
      runProgress.reset();
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
    if (hydrating) {
      pendingEvents.push(envelope);
      return;
    }
    const keepLatestVisible = isNearBottom();
    const progressChanged = runProgress.handleEvent(envelope);
    ingestForCurrentSpace(envelope);
    if (progressChanged && keepLatestVisible) scrollToBottom();
  }

  const bootstrap = runtime.getBootstrap();
  const initialSpace = requestedSpaceId
    ? projectedSpace ?? bootstrap.spaces.find((candidate) => candidate.id === requestedSpaceId)
    : bootstrap.spaces[0];
  const cachedTimeline = initialSpace?.activeSpaceSessionId
    ? timelineCache?.get(initialSpace.id, initialSpace.activeSpaceSessionId)
    : null;
  latestSeq = cachedTimeline?.seq ?? bootstrap.seq;
  if (cachedTimeline) {
    space = initialSpace;
    observation = bootstrap.observation ?? null;
    for (const account of bootstrap.accounts ?? []) accountNameById.set(account.id, account.name);
    store.hydrate([...cachedTimeline.items].reverse());
    hasOlder = cachedTimeline.hasOlder;
    olderButton.hidden = !hasOlder;
    shell?.setSpace(space);
  }
  composer = createComposer({
    targets: bootstrap.accounts.filter((account) => initialSpace?.seats.some((seat) => seat.accountId === account.id)),
    onPickAttachment: async (kind) => {
      if (!space) throw new Error("当前没有可上传附件的 Space");
      const selection = await platform.pickFile({ accept: kind === "image" ? IMAGE_ACCEPT : FILE_ACCEPT });
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
      const result = await spaces.postMessage(space.id, {
        author: { type: "user" },
        target,
        content,
        fileIds,
      });
      runProgress.registerRuns(result.runs);
    },
    onStop: cancelActiveRun,
  });
  composer.setForegroundRuns(runProgress.foregroundRuns(), {
    isGroupChat: (space?.seats?.length ?? 0) > 1,
  });
  if (cachedTimeline) composer.setDisabled(Boolean(space.archivedAt));
  const unsubscribeRuntime = runtime.subscribe(handleRuntimeEvent, { since: latestSeq });
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

  void hydrateFromBootstrap(bootstrap, latestSeq).catch((err) => {
    handleHydrationError("加载时间线失败", err);
  });

  return function unmountSpaceView() {
    if (!mounted) return;
    mounted = false;
    hydrationGeneration += 1;
    pendingEvents = [];
    if (space?.id && space.activeSpaceSessionId) {
      timelineCache?.set(space.id, {
        spaceSessionId: space.activeSpaceSessionId,
        items: store.getOrderedItems(),
        hasOlder,
        seq: latestSeq,
      });
    }
    unsubscribeRuntime();
    unsubscribeStore();
    runProgress.reset();
    nodeByKey.clear();
    root.replaceChildren();
    delete root.dataset.routeScope;
  };
}
