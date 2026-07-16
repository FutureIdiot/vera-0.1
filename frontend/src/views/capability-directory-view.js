import { createHttpClient } from "../api/http-client.js";
import { createAgentsClient } from "../api/agents-client.js";
import { createNotice, setBusy } from "../components/management-ui.js";

const SKILL_PROJECTION = {
  kind: "skill",
  items: [],
  actions: {
    canAdd: false,
    addUnavailableReason: "Skill 接口尚未接入",
    canManage: false,
    manageUnavailableReason: "Skill 接口尚未接入",
  },
};

function mapUnitBindingsToProjection(kind, bindings) {
  return {
    kind,
    items: bindings.map((b) => ({
      id: b.unitId,
      name: b.name,
      summary: b.availability === "available" ? "gateway 内置" : b.availability,
      enabled: b.enabled,
      availability: b.availability,
      version: b.version,
      canToggle: true,
      toggleUnavailableReason: null,
      canOpen: false,
    })),
    actions: {
      canAdd: false,
      addUnavailableReason: "第三方接口尚未接入",
      canManage: false,
      manageUnavailableReason: "第三方接口尚未接入",
    },
  };
}

export async function mountCapabilityDirectoryView({ root, platform, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const hash = window.location.hash;
  const kind = hash.includes("/hooks") ? "hook" : hash.includes("/mcp") ? "mcp" : "skill";
  const kindLabel = kind === "hook" ? "Hooks" : kind === "mcp" ? "MCP" : "Skills";
  const back = `#/agents/${encodeURIComponent(agentId)}`;
  shell?.setManagementHeader({ title: kindLabel, backHref: back, backLabel: "返回" });

  const http = createHttpClient(platform);
  const agentsClient = createAgentsClient(http);

  let disposed = false;
  let loading = true;
  let error = null;
  let projection = kind === "skill" ? SKILL_PROJECTION : null;

  const content = document.createElement("div");
  content.className = "vera-management-content";

  // Header actions
  const headerActions = document.createElement("div");
  headerActions.className = "vera-form-actions";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "vera-secondary-button";
  addBtn.textContent = "添加";
  const manageBtn = document.createElement("button");
  manageBtn.type = "button";
  manageBtn.className = "vera-secondary-button";
  manageBtn.textContent = "管理";
  headerActions.append(addBtn, manageBtn);

  const list = document.createElement("div");
  list.className = "vera-settings-list";

  const feedback = createNotice("");
  feedback.hidden = true;

  content.append(headerActions, list, feedback);
  root.appendChild(content);

  function renderActions() {
    const actions = projection?.actions ?? {};
    addBtn.disabled = !actions.canAdd;
    addBtn.title = actions.addUnavailableReason ?? "";
    manageBtn.disabled = !actions.canManage;
    manageBtn.title = actions.manageUnavailableReason ?? "";
  }

  function renderItem(item) {
    const row = document.createElement("div");
    row.className = "vera-settings-row";
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = item.name;
    const description = document.createElement("small");
    description.textContent = item.summary ?? "";
    copy.append(label, description);

    const toggleWrap = document.createElement("span");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = Boolean(item.enabled);
    toggle.disabled = !item.canToggle;
    toggle.title = item.toggleUnavailableReason ?? (item.enabled ? "已启用" : "已停用");
    toggle.setAttribute("aria-label", `${item.name} ${item.enabled ? "已启用" : "已停用"}`);
    toggleWrap.appendChild(toggle);

    if (item.canToggle) {
      toggle.addEventListener("change", async () => {
        setBusy(toggle, true);
        try {
          const updated = await agentsClient.updateUnitBinding(agentId, item.id, {
            enabled: toggle.checked,
            ifMatch: item.version,
          });
          // Update local version so next toggle works
          item.version = updated.binding.version;
          item.enabled = updated.binding.enabled;
          feedback.textContent = `${item.name} 已${updated.binding.enabled ? "启用" : "停用"}`;
          feedback.dataset.tone = "success";
          feedback.hidden = false;
        } catch (err) {
          toggle.checked = !toggle.checked; // revert
          feedback.textContent = err.message;
          feedback.dataset.tone = "danger";
          feedback.hidden = false;
        } finally {
          setBusy(toggle, false);
        }
      });
    }

    row.append(copy, toggleWrap);
    return row;
  }

  function render() {
    if (loading) {
      list.replaceChildren(createNotice("正在读取…"));
      return;
    }
    if (error) {
      list.replaceChildren(createNotice(error, "danger"));
      return;
    }

    list.replaceChildren();
    renderActions();

    const items = projection?.items ?? [];
    if (!items.length) {
      const empty = createNotice(
        kind === "skill" ? "还没有 Skill" : kind === "hook" ? "还没有 Hook" : "还没有 MCP"
      );
      list.appendChild(empty);
      return;
    }

    for (const item of items) {
      list.appendChild(renderItem(item));
    }
  }

  async function load() {
    loading = true;
    error = null;
    render();

    if (kind === "skill") {
      projection = SKILL_PROJECTION;
      loading = false;
      render();
      return;
    }

    try {
      const res = await agentsClient.listUnitBindings(agentId, kind);
      if (disposed) return;
      projection = mapUnitBindingsToProjection(kind, res.bindings ?? []);
    } catch (err) {
      if (!disposed) error = err.message;
    } finally {
      if (!disposed) {
        loading = false;
        render();
      }
    }
  }

  await load();
  return () => { disposed = true; root.replaceChildren(); };
}
