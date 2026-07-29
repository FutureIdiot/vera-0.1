import {
  activateNavigatorDialog,
  createNavigatorDialogButton,
  nextNavigatorDialogId,
} from "./navigator-dialogs.js";

const STATUS_TEXT = {
  generating: "正在按各 Account 的可见范围提炼当前窗口…",
  ready: "草稿已生成。可以直接编辑，再保存或确认 Forge。",
  failed: "至少一个 Account 未能生成草稿；当前窗口没有变化。",
  stale: "当前窗口已变化，这份草稿不能再确认。",
  cancelled: "Forge 草稿已取消。",
  confirmed: "Forge 已确认。",
};

function targetName(target, accounts) {
  return accounts.find((account) => account.id === target.accountId)?.name ?? target.accountId;
}

export function renderForgeContextCard(draft, accounts = []) {
  const card = document.createElement("details");
  card.className = "vera-forge-card";
  const summary = document.createElement("summary");
  summary.textContent = "Forged context";
  const origin = document.createElement("small");
  origin.textContent = `来源 Session ${draft.sourceSpaceSessionId}`;
  card.append(summary, origin);
  for (const target of draft.targets ?? []) {
    const section = document.createElement("section");
    const heading = document.createElement("strong");
    heading.textContent = targetName(target, accounts);
    const content = document.createElement("pre");
    content.textContent = target.content ?? "";
    section.append(heading, content);
    card.appendChild(section);
  }
  return card;
}

export function openForgeDialog(host, {
  draft: initialDraft,
  accounts = [],
  onRefresh,
  onSave,
  onConfirm,
  onRegenerate,
  onCancel,
  onClose,
  signal,
} = {}) {
  let draft = structuredClone(initialDraft);
  let busy = false;
  let finished = false;
  let deactivate = () => {};
  const textareas = new Map();

  const dialog = document.createElement("section");
  dialog.className = "vera-dialog vera-forge-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const heading = document.createElement("strong");
  heading.textContent = "Forge 当前 Session";
  heading.id = nextNavigatorDialogId("vera-forge-title");
  dialog.setAttribute("aria-labelledby", heading.id);
  const status = document.createElement("p");
  status.className = "vera-dialog__note";
  status.setAttribute("role", "status");
  const body = document.createElement("div");
  body.className = "vera-forge-dialog__body";
  const error = document.createElement("p");
  error.className = "vera-inline-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "vera-dialog__actions vera-forge-dialog__actions";
  dialog.append(heading, status, body, error, actions);
  host.appendChild(dialog);

  function values() {
    return (draft.targets ?? []).map((target) => ({
      accountId: target.accountId,
      content: textareas.get(target.accountId)?.value ?? target.content ?? "",
    }));
  }

  function isDirty() {
    return values().some((target) =>
      target.content.trim() !== (draft.targets.find((item) => item.accountId === target.accountId)?.content ?? ""));
  }

  function setError(value) {
    error.textContent = value ?? "";
    error.hidden = !value;
  }

  async function run(action) {
    if (busy || finished) return null;
    busy = true;
    setError(null);
    render();
    try {
      return await action();
    } catch (err) {
      setError(err.message || "Forge 操作失败");
      return null;
    } finally {
      busy = false;
      if (!finished) render();
    }
  }

  async function saveIfNeeded() {
    if (!isDirty()) return draft;
    const updated = await onSave?.(draft, values());
    if (!updated) throw new Error("Forge 草稿没有保存");
    draft = structuredClone(updated);
    return draft;
  }

  function close() {
    if (finished) return;
    finished = true;
    deactivate();
    dialog.remove();
    onClose?.();
  }

  function renderSources(target) {
    const details = document.createElement("details");
    details.className = "vera-forge-dialog__sources";
    const summary = document.createElement("summary");
    summary.textContent = `来源 ${target.sourceMessageIds?.length ?? 0} 条 Message`;
    const ids = document.createElement("code");
    ids.textContent = (target.sourceMessageIds ?? []).join("\n") || "无来源 Message";
    details.append(summary, ids);
    return details;
  }

  function renderTarget(target) {
    const section = document.createElement("section");
    section.className = "vera-forge-dialog__target";
    const targetHeading = document.createElement("strong");
    targetHeading.textContent = targetName(target, accounts);
    const state = document.createElement("small");
    state.textContent = target.status === "succeeded"
      ? "草稿就绪"
      : target.status === "running"
        ? "正在提炼"
        : target.status === "queued"
          ? "等待执行"
          : target.status === "failed"
            ? "生成失败"
            : "已取消";
    const textarea = document.createElement("textarea");
    textarea.value = target.content ?? "";
    textarea.disabled = busy || draft.status !== "ready";
    textarea.setAttribute("aria-label", `${targetName(target, accounts)} Forge 上下文`);
    textarea.rows = 12;
    textareas.set(target.accountId, textarea);
    section.append(targetHeading, state, textarea, renderSources(target));
    if (target.error?.message) {
      const targetError = document.createElement("p");
      targetError.className = "vera-inline-error";
      targetError.textContent = target.error.message;
      section.appendChild(targetError);
    }
    return section;
  }

  function render() {
    const preserved = new Map([...textareas].map(([accountId, textarea]) => [accountId, textarea.value]));
    textareas.clear();
    status.textContent = STATUS_TEXT[draft.status] ?? draft.status;
    body.replaceChildren();
    for (const target of draft.targets ?? []) {
      const section = renderTarget(target);
      const textarea = textareas.get(target.accountId);
      if (preserved.has(target.accountId) && draft.status === "ready") {
        textarea.value = preserved.get(target.accountId);
      }
      body.appendChild(section);
    }
    actions.replaceChildren();
    actions.appendChild(createNavigatorDialogButton("关闭", "vera-text-button", close));
    if (draft.status === "generating") {
      actions.appendChild(createNavigatorDialogButton(
        "取消生成",
        "vera-text-button",
        () => void run(async () => {
          const updated = await onCancel?.(draft);
          if (updated) draft = structuredClone(updated);
        }),
      ));
    }
    if (["ready", "failed", "stale", "cancelled"].includes(draft.status)) {
      actions.appendChild(createNavigatorDialogButton(
        "重新生成",
        "vera-text-button",
        () => void run(async () => {
          const updated = await onRegenerate?.(draft);
          if (updated) draft = structuredClone(updated);
        }),
      ));
    }
    if (draft.status === "ready") {
      const save = createNavigatorDialogButton(
        "保存草稿",
        "vera-text-button",
        () => void run(async () => { await saveIfNeeded(); }),
      );
      const confirm = createNavigatorDialogButton(
        "确认 Forge",
        "vera-primary-button",
        () => void run(async () => {
          await saveIfNeeded();
          const result = await onConfirm?.(draft);
          if (result) close();
        }),
      );
      save.disabled = busy;
      confirm.disabled = busy;
      actions.append(save, confirm);
    }
    for (const button of actions.querySelectorAll("button")) button.disabled ||= busy;
  }

  render();
  const closeButton = actions.querySelector("button");
  deactivate = activateNavigatorDialog(dialog, closeButton, close, { signal });
  return {
    element: dialog,
    get draft() { return structuredClone(draft); },
    update(nextDraft) {
      if (finished || nextDraft?.id !== draft.id) return;
      draft = structuredClone(nextDraft);
      render();
    },
    async refresh() {
      const updated = await onRefresh?.(draft);
      if (updated) {
        draft = structuredClone(updated);
        render();
      }
      return structuredClone(draft);
    },
    close,
  };
}
