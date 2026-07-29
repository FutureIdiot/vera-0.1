// Per-Run Chat feedback and foreground/background projection. Placeholder
// bubbles are local-only; Run truth always comes from gateway payloads/events.

import { agentStatusLabel } from "../state/agent-status.js";

function stateKey({ agentId, accountId, spaceId } = {}) {
  if (!agentId || !accountId || !spaceId) return null;
  return `${agentId}:${accountId}:${spaceId}`;
}

function runStateKey(run) {
  return stateKey({ agentId: run?.agentId, accountId: run?.accountId, spaceId: run?.spaceId });
}

function active(run) {
  return ["pending", "running"].includes(run?.status);
}

function createDots() {
  const dots = document.createElement("span");
  dots.className = "vera-run-progress__dots";
  dots.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const dot = document.createElement("span");
    dot.className = "vera-run-progress__dot";
    dots.appendChild(dot);
  }
  return dots;
}

function resolvedName(entry, accountName) {
  return entry.run.accountNameSnapshot ?? accountName?.(entry.run.accountId) ?? entry.run.accountId ?? "Account";
}

function createElement(entry, { accountName, isGroupChat, onBackground, onError } = {}) {
  const run = entry.run;
  const name = resolvedName(entry, accountName);
  const element = document.createElement("article");
  element.className = [
    "vera-item", "vera-bubble", "vera-bubble--agent", "vera-bubble--group-solo",
    "vera-bubble--has-tail", "vera-run-progress",
    isGroupChat ? "" : "vera-bubble--private-agent",
  ].filter(Boolean).join(" ");
  element.dataset.runId = run.id;
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");

  const avatar = document.createElement("a");
  avatar.className = "vera-bubble__avatar";
  avatar.textContent = name.charAt(0).toUpperCase();
  avatar.hidden = !isGroupChat;
  avatar.setAttribute("aria-hidden", String(!isGroupChat));
  avatar.tabIndex = isGroupChat ? 0 : -1;
  if (isGroupChat) {
    avatar.href = `#/settings/accounts/${encodeURIComponent(run.accountId)}`;
    avatar.setAttribute("aria-label", `打开 ${name} 设置`);
    avatar.title = name;
  }

  const stack = document.createElement("div");
  stack.className = "vera-bubble__stack";
  const header = document.createElement("div");
  header.className = "vera-run-progress__header";
  const identity = document.createElement("span");
  identity.className = "vera-run-progress__identity";
  identity.textContent = isGroupChat
    ? `${name}${run.effectiveModel ? ` · ${run.effectiveModel}` : ""}`
    : "";
  identity.hidden = !identity.textContent;
  const status = document.createElement("span");
  status.className = "vera-run-progress__status";
  const background = document.createElement("button");
  background.type = "button";
  background.className = "vera-run-progress__background";
  background.textContent = "Go to background";
  background.hidden = true;
  background.addEventListener("click", async () => {
    if (background.disabled) return;
    background.disabled = true;
    try {
      await onBackground?.(run.id);
    } catch (error) {
      background.disabled = false;
      onError?.(error);
    }
  });
  header.append(identity, status, background);

  const surface = document.createElement("div");
  surface.className = "vera-bubble__surface vera-run-progress__surface";
  const label = document.createElement("span");
  label.className = "vera-visually-hidden";
  label.textContent = `${name} 正在准备回复`;
  surface.append(label, createDots());
  stack.append(header, surface);
  element.append(avatar, stack);
  entry.element = element;
  entry.statusElement = status;
  entry.backgroundElement = background;
  return element;
}

export function createRunProgress({
  accountName,
  onBackground,
  onError,
  onRunsChanged,
  now = () => Date.now(),
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  const entries = new Map();
  const states = new Map();
  let container = null;
  let context = { spaceId: null, spaceSessionId: null, isGroupChat: false };

  function foregroundRuns() {
    return [...entries.values()]
      .map((entry) => entry.run)
      .filter((run) => active(run) && run.role === "main" && !run.backgroundedAt)
      .map((run) => structuredClone(run));
  }

  function notify() {
    onRunsChanged?.(foregroundRuns());
  }

  function eligible(entry) {
    const eligibleAt = Date.parse(entry.run.backgroundEligibleAt ?? "");
    return context.isGroupChat && entry.run.status === "running" &&
      entry.run.role === "main" && !entry.run.backgroundedAt &&
      Number.isFinite(eligibleAt) && now() >= eligibleAt;
  }

  function applyEntry(entry) {
    if (entry.statusElement) {
      const label = agentStatusLabel(entry.state?.status ?? "on_task");
      const detail = entry.state?.detail?.trim();
      entry.statusElement.textContent = detail ? `${label} · ${detail}` : label;
    }
    if (entry.backgroundElement) entry.backgroundElement.hidden = !eligible(entry);
  }

  function clearEligibilityTimer(entry) {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
  }

  function scheduleEligibility(entry) {
    clearEligibilityTimer(entry);
    const eligibleAt = Date.parse(entry.run.backgroundEligibleAt ?? "");
    if (!context.isGroupChat || entry.run.status !== "running" || entry.run.backgroundedAt ||
        !Number.isFinite(eligibleAt)) {
      return;
    }
    const delay = Math.max(0, eligibleAt - now());
    if (delay === 0) {
      applyEntry(entry);
      notify();
      return;
    }
    entry.timer = setTimer(() => {
      entry.timer = null;
      applyEntry(entry);
      notify();
    }, delay);
  }

  function renderPlaceholder(entry) {
    if (entry.hasMessage || entry.run.status !== "running" || entry.element) return;
    const element = createElement(entry, {
      accountName,
      isGroupChat: context.isGroupChat,
      onBackground,
      onError,
    });
    applyEntry(entry);
    container?.appendChild(element);
  }

  function upsert(run) {
    if (!run?.id || run.spaceId !== context.spaceId ||
        (context.spaceSessionId && run.spaceSessionId !== context.spaceSessionId) ||
        !active(run)) {
      return false;
    }
    let entry = entries.get(run.id);
    if (!entry) {
      entry = {
        run: structuredClone(run),
        state: states.get(runStateKey(run)) ?? null,
        hasMessage: false,
        element: null,
        statusElement: null,
        backgroundElement: null,
        timer: null,
      };
      entries.set(run.id, entry);
    } else {
      entry.run = { ...entry.run, ...structuredClone(run) };
    }
    renderPlaceholder(entry);
    applyEntry(entry);
    scheduleEligibility(entry);
    notify();
    return true;
  }

  function remove(runId) {
    const entry = entries.get(runId);
    if (!entry) return false;
    clearEligibilityTimer(entry);
    entry.element?.remove();
    entries.delete(runId);
    notify();
    return true;
  }

  function markMessage(runId) {
    const entry = entries.get(runId);
    if (!entry) return false;
    entry.hasMessage = true;
    entry.element?.remove();
    entry.element = null;
    entry.statusElement = null;
    entry.backgroundElement = null;
    notify();
    return true;
  }

  function setContext({ spaceId, spaceSessionId, isGroupChat = false } = {}) {
    if ((context.spaceId && context.spaceId !== spaceId) ||
        (context.spaceSessionId && context.spaceSessionId !== spaceSessionId)) {
      reset();
    }
    context = {
      spaceId: spaceId ?? null,
      spaceSessionId: spaceSessionId ?? null,
      isGroupChat: Boolean(isGroupChat),
    };
    notify();
  }

  function attach(nextContainer) {
    container = nextContainer;
    for (const entry of entries.values()) {
      renderPlaceholder(entry);
      if (entry.element) container?.appendChild(entry.element);
    }
  }

  function hydrate({ runs = [], agentStates = [], messageRunIds = [] } = {}) {
    reset();
    for (const state of agentStates) {
      const key = stateKey(state);
      if (key && state.spaceId === context.spaceId) states.set(key, structuredClone(state));
    }
    for (const run of [...runs].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))) {
      upsert(run);
    }
    for (const runId of messageRunIds) markMessage(runId);
    notify();
  }

  function handleEvent(envelope) {
    if (envelope?.type === "run.started") return upsert(envelope.data?.run);
    if (envelope?.type === "run.backgrounded") return upsert(envelope.data?.run);
    if (envelope?.type === "message.created") return markMessage(envelope.data?.message?.runId);
    if (envelope?.type === "run.ended") return remove(envelope.data?.run?.id);
    if (envelope?.type !== "agent.state.updated") return false;
    const state = envelope.data?.agentState;
    const key = stateKey(state);
    if (!key || state.spaceId !== context.spaceId) return false;
    states.set(key, structuredClone(state));
    let changed = false;
    for (const entry of entries.values()) {
      if (runStateKey(entry.run) !== key) continue;
      entry.state = structuredClone(state);
      applyEntry(entry);
      changed = true;
    }
    if (changed) notify();
    return changed;
  }

  function reset() {
    for (const entry of entries.values()) {
      clearEligibilityTimer(entry);
      entry.element?.remove();
    }
    entries.clear();
    states.clear();
    notify();
  }

  function actionForRun(runId) {
    const entry = entries.get(runId);
    if (!entry || !active(entry.run)) return null;
    if (entry.run.backgroundedAt) return { kind: "stop", run: structuredClone(entry.run) };
    if (eligible(entry)) return { kind: "background", run: structuredClone(entry.run) };
    return null;
  }

  function statusForRun(runId) {
    const entry = entries.get(runId);
    if (!entry || !active(entry.run)) return "";
    const label = agentStatusLabel(entry.state?.status ?? "on_task");
    const detail = entry.state?.detail?.trim();
    return detail ? `${label} · ${detail}` : label;
  }

  return {
    actionForRun,
    attach,
    foregroundRuns,
    handleEvent,
    hydrate,
    registerRuns(runs = []) {
      let changed = false;
      for (const run of runs) changed = upsert(run) || changed;
      return changed;
    },
    reset,
    setContext,
    statusForRun,
  };
}
