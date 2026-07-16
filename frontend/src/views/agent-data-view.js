import { createNotice } from "../components/management-ui.js";

export async function mountAgentDataView({ root, runtime, agentId, shell } = {}) {
  root.dataset.routeScope = "management";
  const agent = runtime.getBootstrap().agents.find((item) => item.id === agentId);
  const back = `#/agents/${encodeURIComponent(agentId)}`;
  shell?.setManagementHeader({ title: "Data", backHref: back, backLabel: "返回" });

  const content = document.createElement("div");
  content.className = "vera-management-content";

  if (!agent) {
    root.appendChild(createNotice("Agent 不存在", "danger"));
    return () => root.replaceChildren();
  }

  const list = document.createElement("div");
  list.className = "vera-settings-list";

  // Memory entry
  const memoryRow = document.createElement("a");
  memoryRow.className = "vera-settings-row";
  memoryRow.href = `#/agents/${encodeURIComponent(agentId)}/data/memory`;
  const copy = document.createElement("span");
  const label = document.createElement("strong");
  label.textContent = "Memory";
  const description = document.createElement("small");
  description.textContent = "长期记忆、Digest 与 Dream 配置";
  copy.append(label, description);
  const suffix = document.createElement("span");
  suffix.textContent = "›";
  memoryRow.append(copy, suffix);
  list.appendChild(memoryRow);

  content.appendChild(list);
  root.appendChild(content);

  return () => root.replaceChildren();
}
