// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/tokens.css）。
// Account 消息显示持久对外身份；头像仅作为冻结 executingAgentId 的设置入口，
// 不改变消息仍由 Account 署名的事实。名称优先使用冻结快照，再查当前 Account 投影。

import { setIconButtonContent } from "./vector-icon.js";

const ACTIONS = [
  ["background", "garage", "Go to background"],
  ["stop", "stop", "中止后台工作"],
  ["retry", "retry", "重试"],
  ["branch", "branch", "分支"],
  ["save", "bookmark", "保存"],
  ["copy", "copy", "复制"],
];

function accountRunKey(item) {
  if (item?.itemType !== "message" || item.author?.type !== "account") return null;
  if (!item.author.accountId || !item.runId) return null;
  return `${item.author.accountId}\u0000${item.runId}`;
}

function messageGroupKey(item) {
  if (item?.itemType !== "message") return null;
  if (item.author?.type === "user") return "user";
  const accountKey = accountRunKey(item);
  return accountKey ? `account\u0000${accountKey}` : null;
}

export function resolveMessageGrouping(items, index, { isGroupChat = false } = {}) {
  const item = items[index];
  const isAccount = item?.itemType === "message" && item.author?.type === "account";
  const isUser = item?.itemType === "message" && item.author?.type === "user";
  if (!isAccount && !isUser) {
    return { position: "solo", showAuthor: false, showAvatar: false, showTail: false };
  }

  const key = messageGroupKey(item);
  const joinsPrevious = Boolean(key && messageGroupKey(items[index - 1]) === key);
  const joinsNext = Boolean(key && messageGroupKey(items[index + 1]) === key);
  const position = joinsPrevious
    ? (joinsNext ? "middle" : "last")
    : (joinsNext ? "first" : "solo");
  return {
    position,
    showAuthor: isAccount && isGroupChat && !joinsPrevious,
    showAvatar: isAccount && isGroupChat && !joinsNext,
    showTail: !joinsNext,
  };
}

function formatTime(timestamp) {
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setSelected(el, selected) {
  el.classList.toggle("is-selected", selected);
  el.setAttribute("aria-expanded", String(selected));
}

function closeOtherSelections(current) {
  for (const bubble of document.querySelectorAll?.(".vera-bubble.is-selected") ?? []) {
    if (bubble !== current) setSelected(bubble, false);
  }
}

function initializeInteractions(el) {
  if (el.dataset.interactionsReady === "true") return;
  el.dataset.interactionsReady = "true";
  let longPressTimer = null;
  const clearLongPress = () => {
    if (longPressTimer !== null) globalThis.clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  const toggle = () => {
    const selected = !el.classList.contains("is-selected");
    if (selected) closeOtherSelections(el);
    setSelected(el, selected);
  };

  el.addEventListener("click", (event) => {
    if (event.target.closest?.("a, button")) return;
    toggle();
  });
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    toggle();
  });
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  });
  el.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    clearLongPress();
    longPressTimer = globalThis.setTimeout(() => {
      closeOtherSelections(el);
      setSelected(el, true);
    }, 500);
  });
  el.addEventListener("pointerup", clearLongPress);
  el.addEventListener("pointercancel", clearLongPress);
  el.addEventListener("pointermove", clearLongPress);
}

function createActionButton(action, icon, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vera-bubble__action vera-bubble__action--${action}`;
  button.dataset.action = action;
  setIconButtonContent(button, icon, label);
  button.setAttribute("aria-label", label);
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    const bubble = button.closest(".vera-bubble");
    const item = bubble?._veraMessageItem;
    const ctx = bubble?._veraMessageContext ?? {};
    if (!item) return;
    if (action === "copy") {
      const copy = ctx.onCopy ?? ((message) => globalThis.navigator?.clipboard?.writeText(message.content ?? ""));
      if (!copy) return;
      await copy(item);
      setIconButtonContent(button, "check", "已复制");
      button.setAttribute("aria-label", "已复制");
      globalThis.setTimeout(() => {
        setIconButtonContent(button, "copy", "复制");
        button.setAttribute("aria-label", "复制");
      }, 1600);
      return;
    }
    try {
      await ctx[`on${action.charAt(0).toUpperCase()}${action.slice(1)}`]?.(item);
    } catch (error) {
      ctx.onActionError?.(error, action, item);
    }
  });
  return button;
}

function ensureStructure(el) {
  let surface = el.querySelector(".vera-bubble__surface");
  if (surface) return;
  el.textContent = "";
  const avatar = document.createElement("a");
  avatar.className = "vera-bubble__avatar";
  const stack = document.createElement("div");
  stack.className = "vera-bubble__stack";
  const workStatus = document.createElement("div");
  workStatus.className = "vera-bubble__work-status";
  const author = document.createElement("div");
  author.className = "vera-bubble__author";
  surface = document.createElement("div");
  surface.className = "vera-bubble__surface";
  const content = document.createElement("div");
  content.className = "vera-bubble__content";
  const text = document.createElement("span");
  text.className = "vera-bubble__text";
  const attachments = document.createElement("div");
  attachments.className = "vera-bubble__attachments";
  const meta = document.createElement("span");
  meta.className = "vera-bubble__meta";
  const time = document.createElement("time");
  time.className = "vera-bubble__time";
  const status = document.createElement("span");
  status.className = "vera-bubble__status";
  meta.append(time, status);
  content.append(text, meta);
  surface.append(content, attachments);
  const actions = document.createElement("div");
  actions.className = "vera-bubble__actions";
  actions.setAttribute("aria-label", "消息操作");
  for (const definition of ACTIONS) actions.appendChild(createActionButton(...definition));
  stack.append(workStatus, author, surface, actions);
  el.append(avatar, stack);
  initializeInteractions(el);
}

export function applyMessageBubble(el, item, ctx = {}) {
  const isUser = item.author?.type === "user";
  const isPrivateAgent = !isUser && ctx.isGroupChat === false;
  const streaming = item.status === "streaming";
  const grouping = ctx.grouping ?? {
    position: "solo",
    showAuthor: false,
    showAvatar: !isUser,
    showTail: true,
  };
  ensureStructure(el);
  el.className = [
    "vera-item",
    "vera-bubble",
    `vera-bubble--${isUser ? "user" : "agent"}`,
    isPrivateAgent ? "vera-bubble--private-agent" : "",
    `vera-bubble--group-${grouping.position}`,
    streaming ? "vera-bubble--streaming" : "",
    grouping.showTail ? "vera-bubble--has-tail" : "",
  ].filter(Boolean).join(" ");
  el.dataset.messageId = item.id;
  el.dataset.groupPosition = grouping.position;
  el.tabIndex = 0;
  el.setAttribute("aria-label", `${isUser ? "你的" : "Account"}消息；点击显示操作`);
  el._veraMessageItem = item;
  el._veraMessageContext = ctx;

  const avatarEl = el.querySelector(".vera-bubble__avatar");
  const authorEl = el.querySelector(".vera-bubble__author");
  const workStatusEl = el.querySelector(".vera-bubble__work-status");
  const contentEl = el.querySelector(".vera-bubble__content");
  const textEl = el.querySelector(".vera-bubble__text");
  const attachmentsEl = el.querySelector(".vera-bubble__attachments");
  const metaEl = el.querySelector(".vera-bubble__meta");
  const timeEl = el.querySelector(".vera-bubble__time");
  const statusEl = el.querySelector(".vera-bubble__status");

  const accountId = item.author?.accountId;
  const accountName = item.accountNameSnapshot ?? ctx.accountName?.(accountId) ?? accountId ?? "";
  const authorName = !isUser && grouping.showAuthor
    ? `${accountName}${item.effectiveModel ? ` · ${item.effectiveModel}` : ""}`
    : "";
  const avatarEligible = !isUser && Boolean(accountId);
  const avatarVisible = avatarEligible && grouping.showAvatar && !isPrivateAgent;
  const avatarLinked = avatarVisible && Boolean(item.executingAgentId);
  avatarEl.textContent = avatarEligible ? (accountName || "?").charAt(0).toUpperCase() : "";
  avatarEl.hidden = !avatarEligible || isPrivateAgent;
  avatarEl.classList.toggle("is-placeholder", avatarEligible && !avatarVisible && !isPrivateAgent);
  avatarEl.setAttribute("aria-hidden", String(!avatarVisible));
  avatarEl.tabIndex = avatarLinked ? 0 : -1;
  if (avatarLinked) {
    avatarEl.href = `#/agents/${encodeURIComponent(item.executingAgentId)}`;
    avatarEl.setAttribute("aria-label", `打开 ${accountName || "Account"} 的 Agent 设置`);
    avatarEl.title = "Agent 设置";
  } else {
    avatarEl.removeAttribute("href");
    avatarEl.removeAttribute("aria-label");
    avatarEl.removeAttribute("title");
  }
  authorEl.textContent = authorName;
  authorEl.hidden = !authorName;
  workStatusEl.textContent = ctx.workStatus ?? "";
  workStatusEl.hidden = !workStatusEl.textContent;
  textEl.textContent = item.content ?? "";
  contentEl.classList.toggle("is-empty", !textEl.textContent);

  attachmentsEl.replaceChildren();
  for (const attachment of item.attachments ?? []) {
    const control = attachment.state === "available"
      ? document.createElement("a")
      : document.createElement("span");
    control.className = "vera-bubble__attachment";
    control.textContent = attachment.state === "available" ? attachment.name : `${attachment.name}（不可用）`;
    if (attachment.state === "available") {
      control.href = `/api/spaces/${encodeURIComponent(item.spaceId)}/files/${encodeURIComponent(attachment.fileId)}/download`;
      control.download = attachment.name;
    }
    attachmentsEl.appendChild(control);
  }
  attachmentsEl.hidden = (item.attachments ?? []).length === 0;

  const timeText = formatTime(item.createdAt);
  timeEl.textContent = timeText;
  timeEl.dateTime = item.createdAt ?? "";
  timeEl.hidden = !timeText;
  statusEl.textContent = streaming ? "生成中" : item.status === "failed" ? "失败" : "";
  statusEl.hidden = !statusEl.textContent;
  metaEl.hidden = !timeText && !statusEl.textContent;

  for (const button of el.querySelectorAll(".vera-bubble__action")) {
    const action = button.dataset.action;
    const available = action === "copy"
      ? Boolean(ctx.onCopy ?? globalThis.navigator?.clipboard?.writeText)
      : typeof ctx[`on${action.charAt(0).toUpperCase()}${action.slice(1)}`] === "function";
    button.hidden = ["background", "stop"].includes(action) && !available;
    button.disabled = !available;
    button.title = available ? button.getAttribute("aria-label") : `${button.getAttribute("aria-label")}（下一步接入）`;
  }
}

export function renderMessageBubble(item, ctx = {}) {
  const el = document.createElement("article");
  applyMessageBubble(el, item, ctx);
  return el;
}
