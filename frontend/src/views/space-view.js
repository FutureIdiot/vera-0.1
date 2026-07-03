// 页面入口（Phase 2：一个输入框 + 一条消息流，plan.md Phase 2 第 5 项）。
// 职责：启动时拉数据 -> 订阅 SSE -> 把事件喂给 state/timeline-store ->
// 按 store 通知做最小化 DOM 更新；不做任何视觉打磨，样式都在 styles/theme.css。

import { fetchBootstrap, fetchTimeline, postMessage, answerApproval } from "../api/gateway-client.js";
import { createReconnectingEventStream } from "../hooks/reconnecting-event-stream.js";
import { createTimelineStore } from "../state/timeline-store.js";
import { renderMessageBubble, applyMessageBubble } from "../components/message-bubble.js";
import { renderActivity, applyActivity } from "../components/activity-item.js";
import { renderApprovalCard, applyApprovalCard } from "../components/approval-card.js";
import { createComposer } from "../components/composer.js";

const TIMELINE_LIMIT = 50;

function keyOf(item) {
  return `${item.itemType}:${item.id}`;
}

async function boot() {
  const app = document.getElementById("app");

  const statusBar = document.createElement("div");
  statusBar.className = "vera-status-bar";
  statusBar.textContent = "连接中…";

  const timelineEl = document.createElement("div");
  timelineEl.className = "vera-timeline";

  app.appendChild(statusBar);
  app.appendChild(timelineEl);

  const store = createTimelineStore();
  const nodeByKey = new Map(); // "itemType:id" -> 已渲染的 DOM 节点

  let space = null;
  let stream = null;

  // agentId -> name，bootstrap 时填充（stream.reset 会重新 bootstrap，新 agent 随之可见）。
  const agentNameById = new Map();
  const bubbleCtx = { agentName: (id) => agentNameById.get(id) };

  async function handleAnswer(approvalId, answer) {
    try {
      await answerApproval(approvalId, answer);
    } catch (err) {
      console.error("vera: answer approval failed", err);
    }
  }

  function renderItem(item) {
    if (item.itemType === "message") return renderMessageBubble(item, bubbleCtx);
    if (item.itemType === "activity") return renderActivity(item);
    if (item.itemType === "approval") return renderApprovalCard(item, { onAnswer: handleAnswer });
    return null;
  }

  function applyItem(el, item) {
    if (item.itemType === "message") return applyMessageBubble(el, item, bubbleCtx);
    if (item.itemType === "activity") return applyActivity(el, item);
    if (item.itemType === "approval") return applyApprovalCard(el, item, { onAnswer: handleAnswer });
  }

  function scrollToBottom() {
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  function fullRender(items) {
    timelineEl.innerHTML = "";
    nodeByKey.clear();
    for (const item of items) {
      const el = renderItem(item);
      if (!el) continue;
      nodeByKey.set(keyOf(item), el);
      timelineEl.appendChild(el);
    }
    scrollToBottom();
  }

  // store 通知：changedKey === null 表示整体重渲染（hydrate/stream.reset 后）；
  // 否则只更新单个已变化的 item，新增的 item 追加到末尾（时间线只往后长）。
  store.subscribe((items, changedKey) => {
    if (changedKey === null) {
      fullRender(items);
      return;
    }
    const item = items.find((i) => keyOf(i) === changedKey);
    if (!item) return;
    const existingEl = nodeByKey.get(changedKey);
    if (existingEl) {
      applyItem(existingEl, item);
    } else {
      const el = renderItem(item);
      if (!el) return;
      nodeByKey.set(changedKey, el);
      timelineEl.appendChild(el);
    }
    scrollToBottom();
  });

  async function loadInitialData() {
    const bootstrap = await fetchBootstrap();
    agentNameById.clear();
    for (const agent of bootstrap.agents ?? []) agentNameById.set(agent.id, agent.name);
    space = bootstrap.spaces[0] ?? null;
    if (!space) {
      statusBar.textContent = "还没有 Space，请先创建一个再刷新页面。";
      return bootstrap.seq;
    }
    const timeline = await fetchTimeline(space.id, { limit: TIMELINE_LIMIT });
    store.hydrate(timeline.items);
    statusBar.textContent = `Space: ${space.name}`;
    return bootstrap.seq;
  }

  async function handleReset() {
    statusBar.textContent = "连接重置，重新同步…";
    const seq = await loadInitialData();
    stream?.resetSince(seq);
  }

  async function handleSend(content) {
    if (!space) return;
    await postMessage(space.id, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content,
    });
  }

  const initialSeq = await loadInitialData();

  stream = createReconnectingEventStream({
    initialSince: initialSeq,
    onEvent: (envelope) => store.ingestEvent(envelope),
    onReset: handleReset,
  });

  const composer = createComposer({ onSend: handleSend });
  app.appendChild(composer.element);
}

boot().catch((err) => {
  console.error("vera: failed to boot frontend", err);
  const app = document.getElementById("app");
  if (app) app.textContent = `启动失败：${err.message}`;
});
