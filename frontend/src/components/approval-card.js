// Approval 卡片：唯一允许的结构化阻塞提问（docs/api-contract.md「Approval」）。
// allow/deny 按钮点击后调用 onAnswer(approvalId, answer)，由上层负责真正
// POST /api/approvals/:id/answer；卡片本身只管渲染与交互。

export function applyApprovalCard(el, item, { onAnswer } = {}) {
  const answered = item.status !== "pending";
  el.className = `vera-item vera-approval${answered ? " vera-approval--answered" : ""}`;
  el.dataset.approvalId = item.id;
  el.innerHTML = "";

  const prompt = document.createElement("p");
  prompt.className = "vera-approval__prompt";
  prompt.textContent = item.prompt;
  el.appendChild(prompt);

  if (answered) {
    const status = document.createElement("p");
    status.textContent = `已答复：${item.answer ?? item.status}`;
    el.appendChild(status);
    return;
  }

  const actions = document.createElement("div");
  actions.className = "vera-approval__actions";
  for (const option of item.options ?? ["allow", "deny"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `vera-approval__button vera-approval__button--${option}`;
    button.textContent = option;
    button.addEventListener("click", () => {
      for (const action of actions.querySelectorAll("button")) action.disabled = true;
      Promise.resolve(onAnswer?.(item.id, option)).catch(() => {
        for (const action of actions.querySelectorAll("button")) action.disabled = false;
      });
    });
    actions.appendChild(button);
  }
  el.appendChild(actions);
}

export function renderApprovalCard(item, opts) {
  const el = document.createElement("div");
  applyApprovalCard(el, item, opts);
  return el;
}
