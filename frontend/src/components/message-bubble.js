// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/tokens.css）。
// Account 消息显示持久对外身份；头像进入 Account 详情，不把实际执行 Agent
// 冒充联系人。名称优先使用消息冻结快照，再查当前 Account 投影。

export function applyMessageBubble(el, item, ctx = {}) {
  const isUser = item.author?.type === "user";
  const streaming = item.status === "streaming";
  el.className = `vera-item vera-bubble vera-bubble--${isUser ? "user" : "agent"}${streaming ? " vera-bubble--streaming" : ""}`;
  el.dataset.messageId = item.id;

  let avatarEl = el.querySelector(".vera-bubble__avatar");
  let authorEl = el.querySelector(".vera-bubble__author");
  let contentEl = el.querySelector(".vera-bubble__content");
  let attachmentsEl = el.querySelector(".vera-bubble__attachments");
  if (!contentEl) {
    el.textContent = "";
    avatarEl = document.createElement("a");
    avatarEl.className = "vera-bubble__avatar";
    authorEl = document.createElement("div");
    authorEl.className = "vera-bubble__author";
    contentEl = document.createElement("div");
    contentEl.className = "vera-bubble__content";
    attachmentsEl = document.createElement("div");
    attachmentsEl.className = "vera-bubble__attachments";
    el.append(avatarEl, authorEl, contentEl, attachmentsEl);
  } else if (!avatarEl) {
    avatarEl = document.createElement("a");
    avatarEl.className = "vera-bubble__avatar";
    el.prepend(avatarEl);
  }

  const accountId = item.author?.accountId;
  const accountName = item.author?.accountNameSnapshot ?? ctx.accountName?.(accountId) ?? accountId ?? "";
  const authorName = isUser
    ? ""
    : `${accountName}${item.author?.effectiveModel ? ` · ${item.author.effectiveModel}` : ""}`;
  const avatarVisible = !isUser && Boolean(accountId);
  avatarEl.textContent = avatarVisible ? (authorName || "?").charAt(0).toUpperCase() : "";
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
  if (!attachmentsEl) {
    attachmentsEl = document.createElement("div");
    attachmentsEl.className = "vera-bubble__attachments";
    el.appendChild(attachmentsEl);
  }
  attachmentsEl.textContent = "";
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
}

export function renderMessageBubble(item, ctx = {}) {
  const el = document.createElement("div");
  applyMessageBubble(el, item, ctx);
  return el;
}
