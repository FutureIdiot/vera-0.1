// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/tokens.css）。
// agent 消息在气泡内顶部显示作者名（群聊 Space 区分谁在说话）；
// 名字由调用方通过 ctx.agentName(agentId) 解析，缺席时回退 agentId。

export function applyMessageBubble(el, item, ctx = {}) {
  const isUser = item.author?.type === "user";
  const streaming = item.status === "streaming";
  el.className = `vera-item vera-bubble vera-bubble--${isUser ? "user" : "agent"}${streaming ? " vera-bubble--streaming" : ""}`;
  el.dataset.messageId = item.id;

  let authorEl = el.querySelector(".vera-bubble__author");
  let contentEl = el.querySelector(".vera-bubble__content");
  if (!contentEl) {
    el.textContent = "";
    authorEl = document.createElement("div");
    authorEl.className = "vera-bubble__author";
    contentEl = document.createElement("div");
    contentEl.className = "vera-bubble__content";
    el.appendChild(authorEl);
    el.appendChild(contentEl);
  }

  const agentId = item.author?.agentId;
  const authorName = isUser ? "" : (ctx.agentName?.(agentId) ?? agentId ?? "");
  authorEl.textContent = authorName;
  authorEl.hidden = !authorName;
  contentEl.textContent = item.content ?? "";
}

export function renderMessageBubble(item, ctx = {}) {
  const el = document.createElement("div");
  applyMessageBubble(el, item, ctx);
  return el;
}
