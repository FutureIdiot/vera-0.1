// 底部输入框：发消息（POST /api/spaces/:id/messages，广播）。
// 只负责收集输入、调用 onSend，不知道 gateway 的 URL 形状。

import { createVectorIcon, setIconButtonContent } from "./vector-icon.js";

export const DEFAULT_COMMANDS = Object.freeze([
  { command: "/new", description: "开始新的 SpaceSession", available: true },
  { command: "/compact", description: "压缩当前上下文", available: true },
  { command: "/resume", description: "选择并恢复旧 Session", available: true },
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

function formatTokens(value) {
  return Math.max(0, Math.round(Number(value) || 0)).toLocaleString("en-US");
}

function formatSessionTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function createComposer({
  onSend,
  onStop,
  onPickAttachment,
  onListSessions,
  onResumeSession,
  onVoice,
  targets = [],
  commands = DEFAULT_COMMANDS,
} = {}) {
  let currentTargets = [...targets];
  let attachments = [];
  let disabled = false;
  let submitting = false;
  let stopping = false;
  let foregroundRuns = [];
  let isGroupChat = false;
  let activeMenu = null;
  let activeIndex = 0;
  let sessionContext = { spaceSession: null, agentSessions: [] };
  let historySessions = [];
  let historyExpanded = false;
  let historyLoading = false;
  let historyLoaded = false;
  let resumingSessionId = null;

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

  const stopMenu = document.createElement("div");
  stopMenu.className = "vera-composer__menu vera-composer__stop-menu";
  stopMenu.hidden = true;
  stopMenu.setAttribute("role", "listbox");
  stopMenu.setAttribute("aria-label", "选择要中止的 Account");

  const sessionMenu = document.createElement("div");
  sessionMenu.className = "vera-composer__menu vera-composer__session-menu";
  sessionMenu.hidden = true;
  sessionMenu.setAttribute("role", "dialog");
  sessionMenu.setAttribute("aria-label", "Session 与上下文");

  const attachmentMenu = document.createElement("div");
  attachmentMenu.className = "vera-composer__menu vera-composer__attachment-menu";
  attachmentMenu.hidden = true;
  attachmentMenu.setAttribute("role", "menu");
  attachmentMenu.setAttribute("aria-label", "添加附件");

  const bar = document.createElement("div");
  bar.className = "vera-composer__bar";
  const attachmentControls = document.createElement("div");
  attachmentControls.className = "vera-composer__tools";
  const session = createIconButton("session", "查看 Session", "vera-composer__tool vera-composer__session-button");
  const attach = createIconButton("plus", "添加附件", "vera-composer__tool");
  attachmentControls.append(session, attach);

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
  form.append(commandMenu, mentionMenu, stopMenu, bar, sessionMenu, attachmentMenu, attachmentList, error);

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
    const stoppingMode = foregroundRuns.length > 0;
    send.type = stoppingMode ? "button" : "submit";
    setIconButtonContent(send, stoppingMode ? "stop" : "send", stoppingMode ? "中止工作" : "发送消息");
    send.setAttribute("aria-label", stoppingMode ? "中止工作" : "发送消息");
    send.title = stoppingMode ? "中止工作" : "发送消息";
    send.disabled = stoppingMode
      ? disabled || stopping || typeof onStop !== "function"
      : disabled || submitting || (!input.value.trim() && attachments.length === 0);
  }

  function resizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  function closeMenus() {
    commandMenu.hidden = true;
    mentionMenu.hidden = true;
    stopMenu.hidden = true;
    sessionMenu.hidden = true;
    attachmentMenu.hidden = true;
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

  function contextAccountName(agentSession) {
    return currentTargets.find((target) => target.id === agentSession.accountId)?.name ?? "Account";
  }

  function contextSummary(agentSession) {
    const used = agentSession.context?.estimatedInputTokens ?? 0;
    const limit = agentSession.context?.contextWindowTokens ?? 0;
    if (!(limit > 0)) return `${formatTokens(used)} tokens · 容量未知`;
    const ratio = Math.max(0, used / limit);
    return `${Math.round(ratio * 100)}% · ${formatTokens(used)} / ${formatTokens(limit)} tokens`;
  }

  function sessionHistoryButton(item) {
    const button = menuButton(
      formatSessionTime(item.createdAt),
      item.id === resumingSessionId ? "正在恢复…" : "点击恢复这个 Session",
      {
        disabled: Boolean(resumingSessionId),
        onSelect: async () => {
          if (!onResumeSession || resumingSessionId) return;
          resumingSessionId = item.id;
          renderSessionMenu();
          error.hidden = true;
          try {
            await onResumeSession(item.id);
            historyExpanded = false;
            historyLoaded = false;
            historySessions = [];
            sessionMenu.hidden = true;
          } catch (err) {
            error.textContent = err.message || "Session 恢复失败，请重试";
            error.hidden = false;
          } finally {
            resumingSessionId = null;
            if (!sessionMenu.hidden) renderSessionMenu();
          }
        },
      },
    );
    button.classList.add("vera-composer__session-history-item");
    return button;
  }

  async function loadSessionHistory() {
    if (historyLoading || historyLoaded || !onListSessions) return;
    historyLoading = true;
    renderSessionMenu();
    try {
      const result = await onListSessions();
      historySessions = (result?.sessions ?? []).filter((item) =>
        item.id !== sessionContext.spaceSession?.id && item.status === "archived");
      historyLoaded = true;
    } catch (err) {
      error.textContent = err.message || "Session 历史加载失败";
      error.hidden = false;
    } finally {
      historyLoading = false;
      if (!sessionMenu.hidden) renderSessionMenu();
    }
  }

  function openSessionHistory() {
    closeMenus();
    historyExpanded = true;
    renderSessionMenu();
    sessionMenu.hidden = false;
    void loadSessionHistory();
  }

  function renderSessionMenu() {
    sessionMenu.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "vera-composer__session-heading";
    const label = document.createElement("span");
    label.textContent = "Context window";
    const sessionTime = document.createElement("small");
    sessionTime.textContent = sessionContext.spaceSession
      ? `当前 Session · ${formatSessionTime(sessionContext.spaceSession.createdAt)}`
      : "当前 Session";
    heading.append(label, sessionTime);
    sessionMenu.appendChild(heading);

    const contexts = document.createElement("div");
    contexts.className = "vera-composer__session-contexts";
    if (sessionContext.agentSessions.length === 0) {
      const unavailable = document.createElement("p");
      unavailable.className = "vera-composer__session-empty";
      unavailable.textContent = "上下文容量暂不可用";
      contexts.appendChild(unavailable);
    } else {
      for (const agentSession of sessionContext.agentSessions) {
        const row = document.createElement("div");
        row.className = "vera-composer__session-context";
        const account = document.createElement("span");
        account.textContent = contextAccountName(agentSession);
        const capacity = document.createElement("strong");
        capacity.textContent = contextSummary(agentSession);
        row.append(account, capacity);
        contexts.appendChild(row);
      }
    }
    sessionMenu.appendChild(contexts);

    const history = menuButton(
      "History",
      historyExpanded ? "收起旧 Session" : "展开旧 Session",
      {
        onSelect: () => {
          historyExpanded = !historyExpanded;
          renderSessionMenu();
          if (historyExpanded) void loadSessionHistory();
        },
      },
    );
    history.classList.add("vera-composer__session-history-toggle");
    sessionMenu.appendChild(history);
    if (!historyExpanded) return;
    if (historyLoading) {
      const loading = document.createElement("p");
      loading.className = "vera-composer__session-empty";
      loading.textContent = "正在加载…";
      sessionMenu.appendChild(loading);
      return;
    }
    if (historyLoaded && historySessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "vera-composer__session-empty";
      empty.textContent = "还没有旧 Session";
      sessionMenu.appendChild(empty);
      return;
    }
    for (const item of historySessions) sessionMenu.appendChild(sessionHistoryButton(item));
  }

  function renderAttachmentMenu() {
    attachmentMenu.replaceChildren();
    const image = menuButton("图片", "从设备中选择图片", {
      onSelect: () => void pick("image"),
    });
    const imageIcon = createVectorIcon("image");
    imageIcon.classList.add("vera-composer__menu-icon");
    image.prepend(imageIcon);
    const file = menuButton("文件", "从设备中选择文件", {
      onSelect: () => void pick("file"),
    });
    const fileIcon = createVectorIcon("file");
    fileIcon.classList.add("vera-composer__menu-icon");
    file.prepend(fileIcon);
    attachmentMenu.append(image, file);
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

  function runName(run) {
    return run.accountNameSnapshot ?? currentTargets.find((target) => target.id === run.accountId)?.name ?? "Account";
  }

  async function stopRuns(runs) {
    const selected = runs.filter(Boolean);
    if (selected.length === 0 || stopping) return;
    stopping = true;
    closeMenus();
    updateSendState();
    error.hidden = true;
    try {
      await Promise.all(selected.map((run) => onStop?.(run.id)));
    } catch (err) {
      error.textContent = err.message || "中止失败，请重试";
      error.hidden = false;
    } finally {
      stopping = false;
      updateSendState();
    }
  }

  function renderStopMenu() {
    stopMenu.replaceChildren();
    for (const run of foregroundRuns) {
      const detail = run.effectiveModel ? `${run.effectiveModel} · 工作中` : "工作中";
      stopMenu.appendChild(menuButton(runName(run), detail, {
        onSelect: () => void stopRuns([run]),
      }));
    }
    commandMenu.hidden = true;
    mentionMenu.hidden = true;
    stopMenu.hidden = foregroundRuns.length === 0;
    activeMenu = stopMenu.hidden ? null : stopMenu;
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
    attach.disabled = true;
    closeMenus();
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
      attach.disabled = disabled;
    }
  }

  session.addEventListener("click", () => {
    const shouldOpen = sessionMenu.hidden;
    closeMenus();
    if (!shouldOpen) return;
    renderSessionMenu();
    sessionMenu.hidden = false;
  });
  attach.addEventListener("click", () => {
    const shouldOpen = attachmentMenu.hidden;
    closeMenus();
    if (!shouldOpen) return;
    renderAttachmentMenu();
    attachmentMenu.hidden = false;
  });
  voice.addEventListener("click", () => void onVoice?.());
  send.addEventListener("click", () => {
    if (foregroundRuns.length === 0) return;
    if (isGroupChat) renderStopMenu();
    else void stopRuns(foregroundRuns);
  });

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
    if (foregroundRuns.length > 0 || (!content && attachments.length === 0) || disabled || submitting) return;
    if (content === "/resume") {
      input.value = "";
      resizeInput();
      updateSendState();
      openSessionHistory();
      return;
    }
    submitting = true;
    updateSendState();
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
        submitting = false;
        updateSendState();
        input.focus();
      });
  });

  function setTargets(nextTargets) {
    currentTargets = [...nextTargets];
    updateSuggestions();
    if (!sessionMenu.hidden) renderSessionMenu();
  }

  function setDisabled(nextDisabled) {
    disabled = nextDisabled;
    input.disabled = disabled;
    session.disabled = disabled;
    attach.disabled = disabled;
    voice.disabled = disabled || typeof onVoice !== "function";
    updateSendState();
  }

  function setSessionContext({
    spaceSession = null,
    agentSessions = [],
  } = {}) {
    const previousSessionId = sessionContext.spaceSession?.id ?? null;
    const nextSessionId = spaceSession?.id ?? null;
    sessionContext = {
      spaceSession: spaceSession ? structuredClone(spaceSession) : null,
      agentSessions: agentSessions.map((item) => structuredClone(item)),
    };
    if (previousSessionId !== nextSessionId) {
      historySessions = [];
      historyExpanded = false;
      historyLoaded = false;
    }
    const ratios = sessionContext.agentSessions
      .map((item) => {
        const used = item.context?.estimatedInputTokens;
        const limit = item.context?.contextWindowTokens;
        return Number.isFinite(used) && Number.isFinite(limit) && limit > 0
          ? used / limit
          : null;
      })
      .filter(Number.isFinite);
    const peak = ratios.length > 0 ? Math.max(...ratios) : null;
    session.title = peak === null
      ? "查看 Session"
      : `查看 Session · ${Math.round(Math.max(0, peak) * 100)}%`;
    if (!sessionMenu.hidden) renderSessionMenu();
  }

  function setForegroundRuns(runs = [], options = {}) {
    foregroundRuns = runs
      .filter((run) => run?.role === "root" && ["pending", "running"].includes(run.status) &&
        run.outputPolicy !== "source")
      .map((run) => structuredClone(run));
    isGroupChat = Boolean(options.isGroupChat);
    if (foregroundRuns.length === 0 || !isGroupChat) stopMenu.hidden = true;
    updateSendState();
  }

  return {
    element: form,
    input,
    setTargets,
    setDisabled,
    setForegroundRuns,
    setSessionContext,
  };
}
