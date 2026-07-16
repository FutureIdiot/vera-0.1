const ENTRIES = [
  ["Account", "Agent 系统身份、连接与授权", "#/settings/accounts"],
  ["System", "隔离、记忆整理与消息呈现", "#/settings/system"],
  ["Appearance", "主题、字体与响应式布局", "#/settings/appearance"],
  ["Paths", "受控校验与迁移", "#/settings/paths"],
  ["Control Center", "Gateway、SSE、store 与最近错误", "#/settings/control-center"],
];

export function mountSettingsIndexView({ root, shell } = {}) {
  root.dataset.routeScope = "management";
  const currentSpace = shell?.getCurrentSpace?.();
  shell?.setManagementHeader({
    title: "Settings",
    backHref: currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/",
    backLabel: "返回",
  });

  const content = document.createElement("div");
  content.className = "vera-settings-index";
  const list = document.createElement("div");
  list.className = "vera-settings-list";
  for (const [name, detail, href] of ENTRIES) {
    const row = document.createElement("a");
    row.className = "vera-settings-row";
    row.href = href;
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = name;
    const description = document.createElement("small");
    description.textContent = detail;
    copy.append(label, description);
    const suffix = document.createElement("span");
    suffix.textContent = "›";
    row.append(copy, suffix);
    list.appendChild(row);
  }
  content.appendChild(list);
  root.appendChild(content);
  return () => root.replaceChildren();
}
