// 底部输入框：发消息（POST /api/spaces/:id/messages，广播）。
// 只负责收集输入、调用 onSend，不知道 gateway 的 URL 形状。

export function createComposer({ onSend, targets = [] } = {}) {
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

  const target = document.createElement("select");
  target.className = "vera-composer__target";
  target.setAttribute("aria-label", "消息发送对象");
  function setTargets(nextTargets) {
    const selected = target.value;
    target.replaceChildren();
    const broadcast = document.createElement("option");
    broadcast.value = "broadcast";
    broadcast.textContent = "全部";
    target.appendChild(broadcast);
    for (const item of nextTargets) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `@${item.name}`;
      target.appendChild(option);
    }
    target.value = [...target.options].some((option) => option.value === selected) ? selected : "broadcast";
  }
  setTargets(targets);

  form.append(target, input);
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
    Promise.resolve(onSend?.(content, target.value === "broadcast" ? { type: "broadcast" } : { type: "direct", agentIds: [target.value] }))
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

  function setDisabled(disabled) {
    input.disabled = disabled;
    target.disabled = disabled;
    button.disabled = disabled;
  }

  return { element: form, input, setTargets, setDisabled };
}
