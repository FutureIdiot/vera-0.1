// 底部输入框：发消息（POST /api/spaces/:id/messages，广播）。
// 只负责收集输入、调用 onSend，不知道 gateway 的 URL 形状。

export function createComposer({ onSend } = {}) {
  const form = document.createElement("form");
  form.className = "vera-composer";

  const input = document.createElement("input");
  input.className = "vera-composer__input";
  input.type = "text";
  input.placeholder = "跟 agent 说点什么…";
  input.autocomplete = "off";

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "vera-composer__send";
  button.textContent = "发送";

  form.appendChild(input);
  form.appendChild(button);

  const error = document.createElement("p");
  error.className = "vera-composer__error";
  error.hidden = true;
  form.appendChild(error);

  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    button.disabled = true;
    error.hidden = true;
    Promise.resolve(onSend?.(content))
      .then(() => { input.value = ""; })
      .catch((err) => {
        console.error("vera: send message failed", err);
        error.textContent = err.message || "发送失败，请重试";
        error.hidden = false;
      })
      .finally(() => {
        button.disabled = false;
        input.focus();
      });
  });

  return { element: form, input };
}
