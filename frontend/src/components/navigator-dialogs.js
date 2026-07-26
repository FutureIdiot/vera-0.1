let dialogSequence = 0;

export function nextNavigatorDialogId(prefix) {
  return `${prefix}-${++dialogSequence}`;
}

export function createNavigatorDialogButton(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

export function activateNavigatorDialog(dialog, initialFocus, onCancel, { signal } = {}) {
  const previousFocus = document.activeElement;
  let active = true;
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll("button, input, select, textarea, a[href]")]
      .filter((element) => !element.disabled && !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const onAbort = () => onCancel();
  dialog.addEventListener("keydown", onKeyDown);
  if (signal?.aborted) queueMicrotask(onAbort);
  else signal?.addEventListener("abort", onAbort, { once: true });
  queueMicrotask(() => {
    if (active && dialog.isConnected) initialFocus.focus();
  });
  return () => {
    if (!active) return;
    active = false;
    dialog.removeEventListener("keydown", onKeyDown);
    signal?.removeEventListener("abort", onAbort);
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}

export function confirmNavigatorAction(host, message, { signal } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("section");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const text = document.createElement("p");
    text.textContent = message;
    text.id = nextNavigatorDialogId("vera-dialog-description");
    dialog.setAttribute("aria-describedby", text.id);
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = createNavigatorDialogButton("取消", "vera-text-button", () => finish(false));
    actions.append(
      cancel,
      createNavigatorDialogButton(
        "确认归档",
        "vera-primary-button vera-primary-button--danger",
        () => finish(true),
      ),
    );
    dialog.append(text, actions);
    host.appendChild(dialog);
    let finished = false;
    const deactivate = activateNavigatorDialog(dialog, cancel, () => finish(false), { signal });
    function finish(value) {
      if (finished) return;
      finished = true;
      deactivate();
      dialog.remove();
      resolve(value);
    }
  });
}

export function confirmSpaceDeletion(host, space, preview, { signal } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = `永久删除“${space.name}”？`;
    heading.id = nextNavigatorDialogId("vera-dialog-title");
    dialog.setAttribute("aria-labelledby", heading.id);
    const summary = document.createElement("p");
    summary.textContent =
      `将删除 ${preview.messageCount} 条消息，并影响 ${preview.affectedMemoryCount} 条 Memory。此操作不可恢复。`;
    const option = document.createElement("label");
    option.className = "vera-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    checkbox.disabled = preview.exclusiveMemoryCount === 0;
    const optionText = document.createElement("span");
    optionText.textContent = preview.exclusiveMemoryCount > 0
      ? `同时删除 ${preview.exclusiveMemoryCount} 条全部来源均属于该 Space 的 Memory`
      : "没有全部来源均属于该 Space 的 Memory";
    option.append(checkbox, optionText);
    const note = document.createElement("p");
    note.className = "vera-dialog__note";
    note.textContent = "不勾选时保留 Memory，原消息来源会标记为已删除，之后仍可在 Memory 库中手动删除。";
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = createNavigatorDialogButton("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button vera-primary-button--danger";
    submit.textContent = "永久删除";
    actions.append(cancel, submit);
    dialog.append(heading, summary, option, note, actions);
    host.appendChild(dialog);
    let finished = false;
    const deactivate = activateNavigatorDialog(dialog, cancel, () => finish(null), { signal });
    const onSubmit = (event) => {
      event.preventDefault();
      finish({ deleteExclusiveMemories: checkbox.checked });
    };
    dialog.addEventListener("submit", onSubmit);
    function finish(value) {
      if (finished) return;
      finished = true;
      dialog.removeEventListener("submit", onSubmit);
      deactivate();
      dialog.remove();
      resolve(value);
    }
  });
}
