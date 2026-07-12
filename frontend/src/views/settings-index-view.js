import { createManagementHeader } from "../components/management-ui.js";

const GROUPS = [
  {
    title: "Vera",
    items: [
      ["Account", "Agent 身份、连接与 Memory", "#/settings/accounts"],
      ["System", "隔离、记忆整理与消息呈现", "#/settings/system"],
      ["Appearance", "主题、字体与响应式布局", "#/settings/appearance"],
    ],
  },
  {
    title: "运行与数据",
    items: [
      ["Paths", "受控校验与迁移", "#/settings/paths"],
      ["Control Center", "Gateway、SSE、store 与最近错误", "#/settings/control-center"],
      ["Extension Packages", "Phase 6 开放", null],
    ],
  },
];

export function mountSettingsIndexView({ root, shell } = {}) {
  root.dataset.routeScope = "management";
  const currentSpace = shell?.getCurrentSpace?.();
  root.appendChild(createManagementHeader({
    title: "Settings",
    backHref: currentSpace ? `#/spaces/${encodeURIComponent(currentSpace.id)}` : "#/",
    backLabel: "返回聊天",
  }));

  const content = document.createElement("div");
  content.className = "vera-settings-index";
  for (const group of GROUPS) {
    const section = document.createElement("section");
    section.className = "vera-settings-group";
    const title = document.createElement("h2");
    title.textContent = group.title;
    const list = document.createElement("div");
    list.className = "vera-settings-list";
    for (const [name, detail, href] of group.items) {
      const row = document.createElement(href ? "a" : "div");
      row.className = "vera-settings-row";
      if (href) row.href = href;
      else row.setAttribute("aria-disabled", "true");
      const copy = document.createElement("span");
      const label = document.createElement("strong");
      label.textContent = name;
      const description = document.createElement("small");
      description.textContent = detail;
      copy.append(label, description);
      const suffix = document.createElement("span");
      suffix.textContent = href ? "›" : "未开放";
      row.append(copy, suffix);
      list.appendChild(row);
    }
    section.append(title, list);
    content.appendChild(section);
  }
  root.appendChild(content);
  return () => root.replaceChildren();
}
