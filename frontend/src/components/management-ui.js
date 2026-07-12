export function createNotice(message, tone = "muted") {
  const notice = document.createElement("p");
  notice.className = "vera-management-notice";
  notice.dataset.tone = tone;
  notice.textContent = message;
  return notice;
}

export function setBusy(button, busy, busyLabel = "处理中…") {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyLabel;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
  button.disabled = busy;
}

export function field(labelText, control, hintText) {
  const label = document.createElement("label");
  label.className = "vera-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, control);
  if (hintText) {
    const hint = document.createElement("small");
    hint.textContent = hintText;
    label.appendChild(hint);
  }
  return label;
}

export function input({ type = "text", value = "", min, step, placeholder } = {}) {
  const control = document.createElement("input");
  control.type = type;
  control.value = value ?? "";
  if (min !== undefined) control.min = String(min);
  if (step !== undefined) control.step = String(step);
  if (placeholder) control.placeholder = placeholder;
  return control;
}

export function select(value, options) {
  const control = document.createElement("select");
  for (const [optionValue, label] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    control.appendChild(option);
  }
  control.value = value ?? "";
  return control;
}

export function downloadText(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function readFileText(file) {
  if (!file) throw new Error("请选择文件");
  return file.text();
}
