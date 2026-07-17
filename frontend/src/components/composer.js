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
  const accountIds = new Set();
  for (let index = content.indexOf("@"); index !== -1; index = content.indexOf("@", index + 1)) {
    for (const target of mentionMatchesAt(content, index, targets)) accountIds.add(target.id);
  }
  return accountIds.size > 0
    ? { type: "direct", accountIds: [...accountIds] }
    : { type: "broadcast" };
}

export function createComposer({ onSend, onPickAttachment, targets = [] } = {}) {
  let currentTargets = [...targets];
  let attachments = [];
  const form = document.createElement("form");
  form.className = "vera-composer";

  const attach = document.createElement("button");
  attach.type = "button";
  attach.className = "vera-composer__attach";
  attach.textContent = "附件";
  attach.setAttribute("aria-label", "上传附件");

  const input = document.createElement("input");
  input.className = "vera-composer__input";
  input.type = "text";
  input.placeholder = "跟 Account 说点什么…";
  input.setAttribute("aria-label", "消息内容");
  input.autocomplete = "off";

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "vera-composer__send";
  button.textContent = "发送";

  function setTargets(nextTargets) {
    currentTargets = [...nextTargets];
  }

  form.append(attach, input, button);

  const attachmentList = document.createElement("div");
  attachmentList.className = "vera-composer__attachments";
  attachmentList.hidden = true;
  form.appendChild(attachmentList);

  const error = document.createElement("p");
  error.className = "vera-composer__error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.appendChild(error);

  function renderAttachments() {
    attachmentList.replaceChildren();
    for (const file of attachments) {
      const chip = document.createElement("span");
      chip.className = "vera-composer__attachment";
      const name = document.createElement("span");
      name.textContent = file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除附件 ${file.name}`);
      remove.addEventListener("click", () => {
        attachments = attachments.filter((item) => item.id !== file.id);
        renderAttachments();
      });
      chip.append(name, remove);
      attachmentList.appendChild(chip);
    }
    attachmentList.hidden = attachments.length === 0;
  }

  attach.addEventListener("click", async () => {
    if (!onPickAttachment) return;
    attach.disabled = true;
    error.hidden = true;
    try {
      const file = await onPickAttachment();
      if (file) {
        attachments = [...attachments.filter((item) => item.id !== file.id), file];
        renderAttachments();
      }
    } catch (err) {
      error.textContent = err.message || "附件上传失败，请重试";
      error.hidden = false;
    } finally {
      attach.disabled = false;
    }
  });

  form.addEventListener("submit", (evt) => {
    evt.preventDefault();
    const content = input.value.trim();
    if (!content && attachments.length === 0) return;
    button.disabled = true;
    error.hidden = true;
    Promise.resolve(onSend?.(content, resolveMessageTarget(content, currentTargets), attachments.map((file) => file.id)))
      .then(() => {
        input.value = "";
        attachments = [];
        renderAttachments();
      })
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
    attach.disabled = disabled;
  }

  return { element: form, input, setTargets, setDisabled };
}
