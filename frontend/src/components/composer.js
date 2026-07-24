// 底部输入框：发消息（POST /api/spaces/:id/messages，广播）。
// 只负责收集输入、调用 onSend，不知道 gateway 的 URL 形状。

import { setIconButtonContent } from "./vector-icon.js";

export const DEFAULT_COMMANDS = Object.freeze([
  { command: "/new", description: "开始新的 SpaceSession", available: true },
  { command: "/compact", description: "压缩当前上下文", available: true },
  { command: "/resume", description: "恢复最近会话", available: false },
  { command: "/forge", description: "编排 Agent 协作流程", available: false },
  { command: "/clear", description: "清理当前聊天", available: false },
  { command: "/export", description: "导出当前对话", available: false },
  { command: "/theme", description: "切换主题", available: false },
  { command: "/help", description: "查看命令帮助", available: false },
]);

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

function createIconButton(icon, label, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  setIconButtonContent(button, icon, label);
  return button;
}

export function createComposer({
  onSend,
  onPickAttachment,
  onVoice,
  targets = [],
  commands = DEFAULT_COMMANDS,
} = {}) {
  let currentTargets = [...targets];
  let attachments = [];
  let disabled = false;
  let activeMenu = null;
  let activeIndex = 0;

  const form = document.createElement("form");
  form.className = "vera-composer";

  const commandMenu = document.createElement("div");
  commandMenu.className = "vera-composer__menu";
  commandMenu.hidden = true;
  commandMenu.setAttribute("role", "listbox");

  const mentionMenu = document.createElement("div");
  mentionMenu.className = "vera-composer__menu";
  mentionMenu.hidden = true;
  mentionMenu.setAttribute("role", "listbox");

  const bar = document.createElement("div");
  bar.className = "vera-composer__bar";
  const attachmentControls = document.createElement("div");
  attachmentControls.className = "vera-composer__tools";
  const image = createIconButton("image", "添加图片", "vera-composer__tool");
  const attach = createIconButton("file", "添加文件", "vera-composer__tool");
  attachmentControls.append(image, attach);

  const input = document.createElement("textarea");
  input.className = "vera-composer__input";
  input.rows = 1;
  input.placeholder = "输入消息… / @";
  input.setAttribute("aria-label", "消息内容");
  input.autocomplete = "off";

  const voice = createIconButton("microphone", "语音输入", "vera-composer__tool");
  voice.disabled = typeof onVoice !== "function";
  if (voice.disabled) voice.title = "语音输入（下一步接入）";

  const send = createIconButton("send", "发送消息", "vera-composer__send");
  send.type = "submit";
  send.disabled = true;
  bar.append(attachmentControls, input, voice, send);

  const attachmentList = document.createElement("div");
  attachmentList.className = "vera-composer__attachments";
  attachmentList.hidden = true;

  const error = document.createElement("p");
  error.className = "vera-composer__error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.append(commandMenu, mentionMenu, bar, attachmentList, error);

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
        updateSendState();
      });
      chip.append(name, remove);
      attachmentList.appendChild(chip);
    }
    attachmentList.hidden = attachments.length === 0;
  }

  function updateSendState() {
    send.disabled = disabled || (!input.value.trim() && attachments.length === 0);
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function closeMenus() {
    commandMenu.hidden = true;
    mentionMenu.hidden = true;
    activeMenu = null;
    activeIndex = 0;
  }

  function replaceTrigger(trigger, value) {
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, cursor);
    const start = before.lastIndexOf(trigger);
    input.value = `${input.value.slice(0, start)}${trigger}${value} ${input.value.slice(cursor)}`;
    closeMenus();
    resizeInput();
    updateSendState();
    input.focus();
  }

  function menuButton(primary, secondary, { disabled: unavailable = false, onSelect } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vera-composer__menu-item";
    button.setAttribute("role", "option");
    button.disabled = unavailable;
    const label = document.createElement("span");
    label.textContent = primary;
    const detail = document.createElement("small");
    detail.textContent = unavailable ? `${secondary} · 下一步接入` : secondary;
    button.append(label, detail);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", onSelect);
    return button;
  }

  function setActiveItem(menu, index) {
    const items = [...menu.querySelectorAll(".vera-composer__menu-item:not(:disabled)")];
    if (items.length === 0) return;
    activeIndex = Math.max(0, Math.min(index, items.length - 1));
    for (const [itemIndex, item] of items.entries()) {
      item.classList.toggle("is-active", itemIndex === activeIndex);
      item.setAttribute("aria-selected", String(itemIndex === activeIndex));
    }
  }

  function renderCommandMenu(filter) {
    commandMenu.replaceChildren();
    const matches = commands.filter((item) => item.command.includes(filter.toLowerCase()));
    for (const item of matches) {
      commandMenu.appendChild(menuButton(item.command, item.description, {
        disabled: !item.available,
        onSelect: () => replaceTrigger("/", item.command.slice(1)),
      }));
    }
    commandMenu.hidden = matches.length === 0;
    mentionMenu.hidden = true;
    activeMenu = commandMenu.hidden ? null : commandMenu;
    activeIndex = 0;
    if (activeMenu) setActiveItem(activeMenu, 0);
  }

  function renderMentionMenu(filter) {
    mentionMenu.replaceChildren();
    const matches = currentTargets.filter((target) => target.name?.toLowerCase().includes(filter.toLowerCase()));
    for (const target of matches) {
      const button = menuButton(target.name, "Account", {
        onSelect: () => replaceTrigger("@", target.name),
      });
      const avatar = document.createElement("span");
      avatar.className = "vera-composer__mention-avatar";
      avatar.textContent = target.name.charAt(0).toUpperCase();
      button.prepend(avatar);
      mentionMenu.appendChild(button);
    }
    mentionMenu.hidden = matches.length === 0;
    commandMenu.hidden = true;
    activeMenu = mentionMenu.hidden ? null : mentionMenu;
    activeIndex = 0;
    if (activeMenu) setActiveItem(activeMenu, 0);
  }

  function updateSuggestions() {
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, cursor);
    const commandMatch = before.match(/(?:^|\s)\/([^\s]*)$/);
    const mentionMatch = before.match(/(?:^|\s)@([^\s]*)$/);
    if (commandMatch) renderCommandMenu(commandMatch[1]);
    else if (mentionMatch) renderMentionMenu(mentionMatch[1]);
    else closeMenus();
  }

  async function pick(kind) {
    if (!onPickAttachment) return;
    image.disabled = true;
    attach.disabled = true;
    error.hidden = true;
    try {
      const file = await onPickAttachment(kind);
      if (file) {
        attachments = [...attachments.filter((item) => item.id !== file.id), file];
        renderAttachments();
        updateSendState();
      }
    } catch (err) {
      error.textContent = err.message || "附件上传失败，请重试";
      error.hidden = false;
    } finally {
      image.disabled = disabled;
      attach.disabled = disabled;
    }
  }

  image.addEventListener("click", () => void pick("image"));
  attach.addEventListener("click", () => void pick("file"));
  voice.addEventListener("click", () => void onVoice?.());

  input.addEventListener("input", () => {
    resizeInput();
    updateSuggestions();
    updateSendState();
  });
  input.addEventListener("click", updateSuggestions);
  input.addEventListener("keydown", (event) => {
    if (activeMenu && !activeMenu.hidden) {
      const selectable = [...activeMenu.querySelectorAll(".vera-composer__menu-item:not(:disabled)")];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveItem(activeMenu, activeIndex + (event.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && selectable[activeIndex]) {
        event.preventDefault();
        selectable[activeIndex].click();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if ((!content && attachments.length === 0) || disabled) return;
    send.disabled = true;
    error.hidden = true;
    closeMenus();
    Promise.resolve(onSend?.(content, resolveMessageTarget(content, currentTargets), attachments.map((file) => file.id)))
      .then(() => {
        input.value = "";
        attachments = [];
        renderAttachments();
        resizeInput();
      })
      .catch((err) => {
        console.error("vera: send message failed", err);
        error.textContent = err.message || "发送失败，请重试";
        error.hidden = false;
      })
      .finally(() => {
        updateSendState();
        input.focus();
      });
  });

  function setTargets(nextTargets) {
    currentTargets = [...nextTargets];
    updateSuggestions();
  }

  function setDisabled(nextDisabled) {
    disabled = nextDisabled;
    input.disabled = disabled;
    image.disabled = disabled;
    attach.disabled = disabled;
    voice.disabled = disabled || typeof onVoice !== "function";
    updateSendState();
  }

  return { element: form, input, setTargets, setDisabled };
}
