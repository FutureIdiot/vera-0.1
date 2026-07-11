export function createRunStatus({ onCancel } = {}) {
  const activeRuns = new Map();
  const element = document.createElement("div");
  element.className = "vera-work-status";
  element.hidden = true;
  const text = document.createElement("span");
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "vera-text-button";
  cancel.textContent = "取消";
  element.append(text, cancel);

  function render() {
    text.textContent = activeRuns.size > 1 ? `${activeRuns.size} 个 Agent 正在处理…` : "Agent 正在处理…";
    element.hidden = activeRuns.size === 0;
  }

  cancel.addEventListener("click", async () => {
    if (activeRuns.size === 0) return;
    cancel.disabled = true;
    try { await onCancel?.([...activeRuns.keys()]); }
    finally { cancel.disabled = false; }
  });

  return {
    element,
    handleEvent(envelope, spaceId) {
      if (envelope.type === "run.started" && envelope.data?.run?.spaceId === spaceId) {
        activeRuns.set(envelope.data.run.id, envelope.data.run);
        render();
      } else if (envelope.type === "run.ended" && envelope.data?.run?.spaceId === spaceId) {
        activeRuns.delete(envelope.data.run.id);
        render();
      } else if (envelope.type === "agent.state.updated" && envelope.data?.agentState) {
        const state = envelope.data.agentState;
        if (!state.spaceId || state.spaceId === spaceId) {
          text.textContent = state.detail || state.status;
          element.hidden = state.status === "idle" && activeRuns.size === 0;
        }
      }
    },
    reset() { activeRuns.clear(); render(); },
  };
}
