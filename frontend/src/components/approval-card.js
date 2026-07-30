// Approval 卡片：唯一允许的结构化阻塞提问（docs/api-contract.md「Approval」）。
// allow/deny 按钮点击后调用 onAnswer(approvalId, answer)，由上层负责真正
// POST /api/approvals/:id/answer；卡片本身只管渲染与交互。

import { createVectorIcon } from "./vector-icon.js";

function optionLabel(option) {
  if (option === "allow") return "Allow once";
  if (option === "allow_session") return "Allow for this session";
  if (option === "deny") return "Deny";
  return option;
}

export function applyApprovalCard(el, item, {
  onAnswer,
  onError,
  requesterName = "Permission request",
  position = 1,
  total = 1,
} = {}) {
  el.className = "vera-approval";
  el.dataset.approvalId = item.id;
  el.replaceChildren();
  el.setAttribute("role", "region");
  el.setAttribute("aria-label", `${requesterName} 权限申请`);

  const header = document.createElement("div");
  header.className = "vera-approval__header";
  header.appendChild(createVectorIcon("command"));
  const source = document.createElement("span");
  source.textContent = requesterName;
  header.appendChild(source);
  if (total > 1) {
    const count = document.createElement("small");
    count.textContent = `${position} / ${total}`;
    header.appendChild(count);
  }

  const prompt = document.createElement("p");
  prompt.className = "vera-approval__prompt";
  prompt.textContent = item.prompt;

  const actions = document.createElement("div");
  actions.className = "vera-approval__actions";
  const options = item.options ?? ["allow", "deny"];
  const controls = [];

  function setSubmitting(submitting) {
    for (const control of controls) control.disabled = submitting;
  }

  function answer(option) {
    setSubmitting(true);
    return Promise.resolve(onAnswer?.(item.id, option)).catch((error) => {
      setSubmitting(false);
      onError?.(error);
    });
  }

  if (options.includes("deny")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "vera-approval__button vera-approval__button--deny";
    button.textContent = optionLabel("deny");
    button.addEventListener("click", () => void answer("deny"));
    controls.push(button);
    actions.appendChild(button);
  }

  if (options.includes("allow")) {
    const additionalAllowOptions = options.filter((option) => !["allow", "deny"].includes(option));
    const split = document.createElement("div");
    split.className = `vera-approval__allow${additionalAllowOptions.length ? " is-split" : ""}`;

    const allow = document.createElement("button");
    allow.type = "button";
    allow.className = "vera-approval__button vera-approval__button--allow";
    allow.textContent = optionLabel("allow");
    allow.addEventListener("click", () => void answer("allow"));
    controls.push(allow);
    split.appendChild(allow);

    if (additionalAllowOptions.length) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "vera-approval__allow-toggle";
      toggle.setAttribute("aria-label", "更多允许选项");
      toggle.setAttribute("aria-haspopup", "menu");
      toggle.setAttribute("aria-expanded", "false");
      toggle.appendChild(createVectorIcon("chevron-down"));
      controls.push(toggle);

      const menu = document.createElement("div");
      menu.className = "vera-approval__allow-menu";
      menu.hidden = true;
      menu.setAttribute("role", "menu");

      function closeMenu() {
        menu.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      }

      toggle.addEventListener("click", () => {
        const open = menu.hidden;
        menu.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        if (open) menu.querySelector("button")?.focus();
      });

      split.addEventListener("focusout", (event) => {
        if (!split.contains(event.relatedTarget)) closeMenu();
      });
      split.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || menu.hidden) return;
        event.preventDefault();
        closeMenu();
        toggle.focus();
      });

      for (const option of additionalAllowOptions) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "vera-approval__allow-choice";
        choice.setAttribute("role", "menuitem");
        const label = document.createElement("span");
        label.textContent = optionLabel(option);
        choice.appendChild(label);
        if (option === "allow_session" && item.sessionRule?.label) {
          const detail = document.createElement("small");
          detail.textContent = item.sessionRule.label;
          choice.appendChild(detail);
        }
        choice.addEventListener("click", () => {
          closeMenu();
          void answer(option);
        });
        controls.push(choice);
        menu.appendChild(choice);
      }
      split.append(toggle, menu);
    }
    actions.appendChild(split);
  }
  el.append(header, prompt, actions);
}

export function renderApprovalCard(item, opts) {
  const el = document.createElement("div");
  applyApprovalCard(el, item, opts);
  return el;
}
