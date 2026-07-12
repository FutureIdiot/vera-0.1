// 底部输入框：发消息（POST /api/spaces/:id/messages，广播）。
// 只负责收集输入、调用 onSend，不知道 gateway 的 URL 形状。

function mentionMatchesAt(content, index, targets) {
  const matches = targets
    .filter((target) => target?.id && target?.name && content.startsWith(`@${target.name}`, index))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) return [];
  const longestName = matches[0].name;
  return matches.filter((target) => target.name === longestName);
}

export function resolveMessageTarget(content, targets = []) {
  const agentIds = new Set();
  for (let index = content.indexOf("@"); index !== -1; index = content.indexOf("@", index + 1)) {
    for (const target of mentionMatchesAt(content, index, targets)) agentIds.add(target.id);
  }
  return agentIds.size > 0
    ? { type: "direct", agentIds: [...agentIds] }
    : { type: "broadcast" };
}

export function createComposer({ onSend, targets = [] } = {}) {
  let currentTargets = [...targets];
  const form = document.createElement("form");
  form.className = "vera-composer";

  const input = document.createElement("input");
  input.className = "vera-composer__input";
  input.type = "text";
  input.placeholder = "跟 agent 说点什么…";
  input.setAttribute("aria-label", "消息内容");
  input.autocomplete = "off";

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "vera-composer__send";
  button.textContent = "发送";

  function setTargets(nextTargets) {
    currentTargets = [...nextTargets];
  }

  form.append(input, button);

  const error = document.createElement("p");
  error.className = "vera-composer__error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.appendChild(error);

  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    button.disabled = true;
    error.hidden = true;
    Promise.resolve(onSend?.(content, resolveMessageTarget(content, currentTargets)))
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
    button.disabled = disabled;
  }

  return { element: form, input, setTargets, setDisabled };
}
