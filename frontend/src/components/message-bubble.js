// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/tokens.css）。
// agent 消息显示可进入该 Agent 使用管理页的头像与作者名；
// 名字由调用方通过 ctx.agentName(agentId) 解析，缺席时回退 agentId。

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

  const agentId = item.author?.agentId;
  const authorName = isUser ? "" : (ctx.agentName?.(agentId) ?? agentId ?? "");
  const avatarVisible = !isUser && Boolean(agentId);
  avatarEl.textContent = avatarVisible ? (authorName || "?").charAt(0).toUpperCase() : "";
  avatarEl.hidden = !avatarVisible;
  if (avatarVisible) {
    avatarEl.href = `#/agents/${encodeURIComponent(agentId)}`;
    avatarEl.setAttribute("aria-label", `打开 ${authorName || "Agent"} 设置`);
    avatarEl.title = authorName || "Agent";
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
