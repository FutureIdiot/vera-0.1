import { createHttpClient } from "../api/http-client.js";
import { createAgentsClient } from "../api/agents-client.js";
import { createAccountsClient } from "../api/accounts-client.js";
import { createNotice, setBusy } from "../components/management-ui.js";

function createPixelAvatar(agentName) {
  const wrapper = document.createElement("div");
  wrapper.className = "vera-agent-avatar";
  const canvas = document.createElement("div");
  canvas.className = "vera-agent-avatar__canvas";
  const initial = document.createElement("span");
  initial.className = "vera-agent-avatar__initial";
  initial.textContent = (agentName ?? "?").charAt(0).toUpperCase();
  canvas.appendChild(initial);
  wrapper.appendChild(canvas);
  return wrapper;
}

function createArrowButton({ direction, onClick }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `vera-agent-avatar__arrow vera-agent-avatar__arrow--${direction}`;
  btn.setAttribute("aria-label", direction === "prev" ? "上一个 Agent" : "下一个 Agent");
  btn.textContent = direction === "prev" ? "‹" : "›";
  btn.addEventListener("click", onClick);
  return btn;
}

function createInfoRow(label, value) {
  const row = document.createElement("div");
  row.className = "vera-agent-info-row";
  const labelEl = document.createElement("span");
  labelEl.className = "vera-agent-info-row__label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "vera-agent-info-row__value";
  if (value instanceof Node) valueEl.appendChild(value);
  else valueEl.textContent = value ?? "—";
  row.append(labelEl, valueEl);
  return row;
}

function createDirectoryEntry({ name, detail, href, disabledReason = null }) {
  const row = document.createElement("a");
  row.className = "vera-settings-row";
  if (disabledReason) {
    row.classList.add("is-disabled");
    row.removeAttribute("href");
    row.setAttribute("role", "button");
    row.setAttribute("aria-disabled", "true");
  } else {
    row.href = href;
  }
  const copy = document.createElement("span");
  const label = document.createElement("strong");
  label.textContent = name;
  const description = document.createElement("small");
  description.textContent = disabledReason ?? detail;
  copy.append(label, description);
  const suffix = document.createElement("span");
  suffix.textContent = disabledReason ? "⊘" : "›";
  row.append(copy, suffix);
  return row;
}

export async function mountAccountDetailView({ root, platform, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const http = createHttpClient(platform);
  const agentsClient = createAgentsClient(http);
  const accountsClient = createAccountsClient(http);

  let disposed = false;
  let agents = [];
  let agent = null;
  let account = null;
  let agentStates = [];
  let hooks = [];
  let mcps = [];
  let loading = true;
  let error = null;

  const back = "#/settings/accounts";

  // ── Layout ──
  const content = document.createElement("div");
  content.className = "vera-management-content";

  // Avatar area
  const avatarArea = document.createElement("div");
  avatarArea.className = "vera-agent-avatar-area";

  // Info panel
  const infoPanel = document.createElement("div");
  infoPanel.className = "vera-agent-info-panel";

  // Directory list
  const directoryList = document.createElement("div");
  directoryList.className = "vera-settings-list";

  // Feedback / notice
  const feedback = createNotice("");
  feedback.hidden = true;

  // Danger zone
  const dangerZone = document.createElement("div");
  dangerZone.className = "vera-management-section";
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "vera-danger-button";
  deleteBtn.textContent = "删除 Agent 身份";
  dangerZone.appendChild(deleteBtn);

  content.append(avatarArea, infoPanel, directoryList, feedback, dangerZone);
  root.appendChild(content);

  // ── Render helpers ──
  function renderAvatar() {
    avatarArea.replaceChildren();
    if (!agent) return;

    const prevBtn = createArrowButton({
      direction: "prev",
      onClick: () => {
        if (agents.length <= 1) return;
        const idx = agents.findIndex((a) => a.id === agentId);
        const prev = agents[(idx - 1 + agents.length) % agents.length];
        window.location.hash = `#/settings/accounts/${encodeURIComponent(prev.id)}`;
      },
    });
    const nextBtn = createArrowButton({
      direction: "next",
      onClick: () => {
        if (agents.length <= 1) return;
        const idx = agents.findIndex((a) => a.id === agentId);
        const next = agents[(idx + 1) % agents.length];
        window.location.hash = `#/settings/accounts/${encodeURIComponent(next.id)}`;
      },
    });

    const avatar = createPixelAvatar(agent.name);
    const nameEl = document.createElement("h2");
    nameEl.className = "vera-agent-name";
    nameEl.textContent = agent.name;

    avatarArea.append(prevBtn, avatar, nextBtn, nameEl);
  }

  function renderInfo() {
    infoPanel.replaceChildren();
    if (!agent) return;

    // Status: pick the most recent active state, or idle
    const latestState = agentStates.length
      ? agentStates.slice().sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt))[0]
      : null;
    const statusText = latestState ? `${latestState.status}${latestState.detail ? ` · ${latestState.detail}` : ""}` : "idle";

    // Presence
    const presenceText = account
      ? `${account.presence ?? "unknown"}${account.lastSeenAt ? ` · ${formatAge(account.lastSeenAt)}` : ""}`
      : "—";

    // Usage placeholder: show provider + model as a lightweight placeholder
    const usageText = account
      ? `${account.provider ?? "—"}${account.model ? ` / ${account.model}` : ""}`
      : "—";

    infoPanel.append(
      createInfoRow("状态", statusText),
      createInfoRow("位置", presenceText),
      createInfoRow("Usage", usageText),
    );
  }

  function renderDirectory() {
    directoryList.replaceChildren();
    if (!agent) return;

    // Skills: always empty until Extension Package/Skill contract lands
    directoryList.appendChild(createDirectoryEntry({
      name: "Skills",
      detail: "还没有 Skill",
      href: `#/settings/accounts/${encodeURIComponent(agentId)}/skills`,
      disabledReason: "Skill 接口尚未接入",
    }));

    // Hooks
    const hookCount = hooks.length;
    directoryList.appendChild(createDirectoryEntry({
      name: "Hooks",
      detail: hookCount ? `${hookCount} 项` : "空",
      href: `#/settings/accounts/${encodeURIComponent(agentId)}/hooks`,
    }));

    // MCP
    const mcpCount = mcps.length;
    directoryList.appendChild(createDirectoryEntry({
      name: "MCP",
      detail: mcpCount ? `${mcpCount} 项` : "空",
      href: `#/settings/accounts/${encodeURIComponent(agentId)}/mcp`,
    }));

    // Data
    directoryList.appendChild(createDirectoryEntry({
      name: "Data",
      detail: "Memory",
      href: `#/settings/accounts/${encodeURIComponent(agentId)}/data`,
    }));
  }

  function renderAll() {
    shell?.setManagementHeader({
      title: agent?.name ?? "Account",
      backHref: back,
      backLabel: "返回",
    });

    if (loading) {
      content.replaceChildren(createNotice("正在读取…"));
      return;
    }

    if (error) {
      content.replaceChildren(createNotice(error, "danger"));
      return;
    }

    if (!agent) {
      content.replaceChildren(createNotice("Agent 不存在", "danger"));
      return;
    }

    // Ensure all sections are in DOM
    if (!content.contains(avatarArea)) content.prepend(avatarArea);
    if (!content.contains(infoPanel)) content.insertBefore(infoPanel, directoryList);
    if (!content.contains(directoryList)) content.insertBefore(directoryList, feedback);
    if (!content.contains(feedback)) content.insertBefore(feedback, dangerZone);
    if (!content.contains(dangerZone)) content.appendChild(dangerZone);

    renderAvatar();
    renderInfo();
    renderDirectory();
  }

  // ── Data loading ──
  async function load() {
    loading = true;
    error = null;
    renderAll();

    try {
      const [agentsRes, statesRes, accountsRes, hooksRes, mcpsRes] = await Promise.all([
        agentsClient.list().catch(() => ({ agents: runtime.getBootstrap().agents })),
        agentsClient.listStates(agentId),
        accountsClient.list(agentId),
        agentsClient.listUnitBindings(agentId, "hook").catch(() => ({ bindings: [] })),
        agentsClient.listUnitBindings(agentId, "mcp").catch(() => ({ bindings: [] })),
      ]);

      if (disposed) return;

      agents = agentsRes.agents ?? [];
      agent = agents.find((a) => a.id === agentId) ?? null;
      agentStates = statesRes.agentStates ?? [];
      const accounts = accountsRes.accounts ?? [];
      account = accounts[0] ?? null; // Home Account
      hooks = hooksRes.bindings ?? [];
      mcps = mcpsRes.bindings ?? [];
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      if (!disposed) {
        loading = false;
        renderAll();
      }
    }
  }

  // ── Actions ──
  deleteBtn.addEventListener("click", async () => {
    if (!agent) return;
    if (!window.confirm(`删除 Agent「${agent.name}」及其身份与连接？此操作不可撤销。`)) return;
    setBusy(deleteBtn, true, "删除中…");
    try {
      await agentsClient.remove(agentId);
      runtime.removeAgent(agentId);
      window.location.hash = "#/settings/accounts";
    } catch (err) {
      feedback.textContent = err.message;
      feedback.dataset.tone = "danger";
      feedback.hidden = false;
    } finally {
      setBusy(deleteBtn, false);
    }
  });

  // ── Bootstrap ──
  await load();

  // SSE refresh for states / accounts
  const unsubscribe = runtime.subscribe((envelope) => {
    if (
      envelope.type === "account.presence.updated" ||
      envelope.type === "account.upserted" ||
      envelope.type === "agent.state.updated"
    ) {
      void load();
    }
  });

  return () => {
    disposed = true;
    unsubscribe();
    root.replaceChildren();
  };
}

function formatAge(isoString) {
  try {
    const then = new Date(isoString).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - then);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.floor(hours / 24);
    return `${days} 天前`;
  } catch {
    return "";
  }
}
