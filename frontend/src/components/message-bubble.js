// Message 气泡：随 message.delta 流式增长、message.completed 以全文覆盖
// （docs/api-contract.md 四、客户端义务）。样式一律走 CSS 变量（styles/theme.css）。

export function applyMessageBubble(el, item) {
  const isUser = item.author?.type === "user";
  const streaming = item.status === "streaming";
  el.className = `vera-item vera-bubble vera-bubble--${isUser ? "user" : "agent"}${streaming ? " vera-bubble--streaming" : ""}`;
  el.textContent = item.content ?? "";
  el.dataset.messageId = item.id;
}

export function renderMessageBubble(item) {
  const el = document.createElement("div");
  applyMessageBubble(el, item);
  return el;
}
