let dialogSequence = 0;

function button(label, className, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function activateDialog(dialog, initialFocus, onCancel) {
  const previousFocus = document.activeElement;
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
  dialog.addEventListener("keydown", onKeyDown);
  queueMicrotask(() => initialFocus.focus());
  return () => {
    dialog.removeEventListener("keydown", onKeyDown);
    if (previousFocus?.isConnected) previousFocus.focus();
  };
}

export function requestNavigatorText(host, title, initialValue = "") {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = title;
    heading.id = `vera-dialog-title-${++dialogSequence}`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const input = document.createElement("input");
    input.value = initialValue;
    input.required = true;
    input.setAttribute("aria-label", title);
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = button("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button";
    submit.textContent = "确定";
    actions.append(cancel, submit);
    dialog.append(heading, input, actions);
    host.appendChild(dialog);
    const deactivate = activateDialog(dialog, input, () => finish(null));
    function finish(value) { deactivate(); dialog.remove(); resolve(value); }
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(input.value.trim() || null);
    });
  });
}

export function confirmNavigatorAction(host, message) {
  return new Promise((resolve) => {
    const dialog = document.createElement("section");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const text = document.createElement("p");
    text.textContent = message;
    text.id = `vera-dialog-description-${++dialogSequence}`;
    dialog.setAttribute("aria-describedby", text.id);
    const actions = document.createElement("div");
    actions.className = "vera-dialog__actions";
    const cancel = button("取消", "vera-text-button", () => finish(false));
    actions.append(
      cancel,
      button("确认归档", "vera-primary-button vera-primary-button--danger", () => finish(true)),
    );
    dialog.append(text, actions);
    host.appendChild(dialog);
    const deactivate = activateDialog(dialog, cancel, () => finish(false));
    function finish(value) { deactivate(); dialog.remove(); resolve(value); }
  });
}

export function confirmSpaceDeletion(host, space, preview) {
  return new Promise((resolve) => {
    const dialog = document.createElement("form");
    dialog.className = "vera-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const heading = document.createElement("strong");
    heading.textContent = `永久删除“${space.name}”？`;
    heading.id = `vera-dialog-title-${++dialogSequence}`;
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
    const cancel = button("取消", "vera-text-button", () => finish(null));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "vera-primary-button vera-primary-button--danger";
    submit.textContent = "永久删除";
    actions.append(cancel, submit);
    dialog.append(heading, summary, option, note, actions);
    host.appendChild(dialog);
    const deactivate = activateDialog(dialog, cancel, () => finish(null));
    function finish(value) { deactivate(); dialog.remove(); resolve(value); }
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      finish({ deleteExclusiveMemories: checkbox.checked });
    });
  });
}
