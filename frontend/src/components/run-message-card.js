export function renderRunMessageCard(item, { onReply, onError } = {}) {
  const card = document.createElement("article");
  card.className = "vera-item vera-run-message";
  card.dataset.runMessageId = item.id;

  const header = document.createElement("div");
  header.className = "vera-run-message__header";
  header.textContent = item.kind === "blocked" ? "后台工作需要处理" : "后台工作";

  const content = document.createElement("div");
  content.className = "vera-run-message__content";
  content.textContent = item.content ?? "";

  const reply = document.createElement("button");
  reply.type = "button";
  reply.className = "vera-text-button";
  reply.textContent = "回复后台 Agent";

  const form = document.createElement("form");
  form.className = "vera-run-message__reply";
  form.hidden = true;
  const input = document.createElement("textarea");
  input.rows = 2;
  input.placeholder = "补充指令";
  const send = document.createElement("button");
  send.type = "submit";
  send.className = "vera-primary-button";
  send.textContent = "发送";
  form.append(input, send);

  reply.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) input.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    send.disabled = true;
    try {
      await onReply?.(item, input.value.trim());
      input.value = "";
      form.hidden = true;
    } catch (error) {
      onError?.(error);
    } finally {
      send.disabled = false;
    }
  });

  card.append(header, content, reply, form);
  return card;
}
