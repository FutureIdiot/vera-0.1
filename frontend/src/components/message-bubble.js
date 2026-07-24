// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/tokens.css）。
// Account 消息显示持久对外身份；头像进入 Account 详情，不把实际执行 Agent
// 冒充联系人。名称优先使用消息冻结快照，再查当前 Account 投影。

import { setIconButtonContent } from "./vector-icon.js";

const ACTIONS = [
  ["retry", "retry", "重试"],
  ["branch", "branch", "分支"],
  ["save", "bookmark", "保存"],
  ["copy", "copy", "复制"],
];

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
    await ctx[`on${action.charAt(0).toUpperCase()}${action.slice(1)}`]?.(item);
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
  const author = document.createElement("div");
  author.className = "vera-bubble__author";
  surface = document.createElement("div");
  surface.className = "vera-bubble__surface";
  const content = document.createElement("div");
  content.className = "vera-bubble__content";
  const attachments = document.createElement("div");
  attachments.className = "vera-bubble__attachments";
  const meta = document.createElement("div");
  meta.className = "vera-bubble__meta";
  const time = document.createElement("time");
  time.className = "vera-bubble__time";
  const status = document.createElement("span");
  status.className = "vera-bubble__status";
  meta.append(time, status);
  surface.append(content, attachments, meta);
  const actions = document.createElement("div");
  actions.className = "vera-bubble__actions";
  actions.setAttribute("aria-label", "消息操作");
  for (const definition of ACTIONS) actions.appendChild(createActionButton(...definition));
  stack.append(author, surface, actions);
  el.append(avatar, stack);
  initializeInteractions(el);
}

export function applyMessageBubble(el, item, ctx = {}) {
  const isUser = item.author?.type === "user";
  const streaming = item.status === "streaming";
  ensureStructure(el);
  el.className = `vera-item vera-bubble vera-bubble--${isUser ? "user" : "agent"}${streaming ? " vera-bubble--streaming" : ""}`;
  el.dataset.messageId = item.id;
  el.tabIndex = 0;
  el.setAttribute("aria-label", `${isUser ? "你的" : "Account"}消息；点击显示操作`);
  el._veraMessageItem = item;
  el._veraMessageContext = ctx;

  const avatarEl = el.querySelector(".vera-bubble__avatar");
  const authorEl = el.querySelector(".vera-bubble__author");
  const contentEl = el.querySelector(".vera-bubble__content");
  const attachmentsEl = el.querySelector(".vera-bubble__attachments");
  const timeEl = el.querySelector(".vera-bubble__time");
  const statusEl = el.querySelector(".vera-bubble__status");

  const accountId = item.author?.accountId;
  const accountName = item.author?.accountNameSnapshot ?? ctx.accountName?.(accountId) ?? accountId ?? "";
  const authorName = isUser
    ? ""
    : `${accountName}${item.author?.effectiveModel ? ` · ${item.author.effectiveModel}` : ""}`;
  const avatarVisible = !isUser && Boolean(accountId);
  avatarEl.textContent = avatarVisible ? (accountName || "?").charAt(0).toUpperCase() : "";
  avatarEl.hidden = !avatarVisible;
  if (avatarVisible) {
    avatarEl.href = `#/settings/accounts/${encodeURIComponent(accountId)}`;
    avatarEl.setAttribute("aria-label", `打开 ${accountName || "Account"} 设置`);
    avatarEl.title = accountName || "Account";
  } else {
    avatarEl.removeAttribute("href");
    avatarEl.removeAttribute("aria-label");
    avatarEl.removeAttribute("title");
  }
  authorEl.textContent = authorName;
  authorEl.hidden = !authorName;
  contentEl.textContent = item.content ?? "";

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

  for (const button of el.querySelectorAll(".vera-bubble__action")) {
    const action = button.dataset.action;
    const available = action === "copy"
      ? Boolean(ctx.onCopy ?? globalThis.navigator?.clipboard?.writeText)
      : typeof ctx[`on${action.charAt(0).toUpperCase()}${action.slice(1)}`] === "function";
    button.disabled = !available;
    button.title = available ? button.getAttribute("aria-label") : `${button.getAttribute("aria-label")}（下一步接入）`;
  }
}

export function renderMessageBubble(item, ctx = {}) {
  const el = document.createElement("article");
  applyMessageBubble(el, item, ctx);
  return el;
}
