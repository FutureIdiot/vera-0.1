// Activity：provider公开reasoning / 工具执行记录，时间线正式成员，随
// activity.updated 原地更新（docs/api-contract.md「Activity」）。

import { createVectorIcon } from "./vector-icon.js";

const CATEGORY = {
  thinking: { key: "thinking", fallback: "正在分析请求" },
  tool: { key: "tool", fallback: "正在执行操作" },
};

const KIND = {
  reasoning: { icon: "reasoning", label: "思考过程" },
  command: { icon: "command", label: "命令执行" },
  read: { icon: "read", label: "读取文件" },
  edit: { icon: "edit", label: "编辑文件" },
  search: { icon: "search", label: "搜索" },
  plan: { icon: "plan", label: "计划更新" },
  compact: { icon: "compact", label: "上下文压缩" },
  tool: { icon: "tool", label: "工具调用" },
  status: { icon: "status", label: "过程状态" },
  usage: { icon: "usage", label: "用量更新" },
  error: { icon: "error", label: "错误" },
};

function singleLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function legacyKind(item) {
  if (item.phase === "thinking") return "reasoning";
  if (item.phase === "error") return "error";
  if (item.phase === "usage") return "usage";
  return item.phase === "tool" ? "tool" : "status";
}

export function activityKind(item) {
  return KIND[item.kind] ? item.kind : legacyKind(item);
}

export function activityIconName(item) {
  return KIND[activityKind(item)].icon;
}

export function activitySummary(item) {
  const category = CATEGORY[item.phase];
  const summary = singleLine(item.summary) || singleLine(String(item.detail ?? "").split(/\r?\n/u)[0]);
  if (summary) return summary;
  const label = singleLine(item.label);
  return label || category?.fallback || KIND[activityKind(item)].label;
}

function toggleExpanded(el, expanded) {
  const button = el.querySelector(".vera-activity__toggle");
  const detail = el.querySelector(".vera-activity__detail");
  el.classList.toggle("is-expanded", expanded);
  el.dataset.expansionPreference = expanded ? "expanded" : "collapsed";
  button?.setAttribute("aria-expanded", String(expanded));
  if (detail) detail.hidden = !expanded;
}

export function applyActivity(el, item, { canExpand = false } = {}) {
  const category = CATEGORY[item.phase] ?? {
    key: "status",
    fallback: "过程更新",
  };
  const kind = activityKind(item);
  const kindMeta = KIND[kind];
  const detailText = String(item.detail ?? "").trim();
  const expandable = Boolean(canExpand && detailText && CATEGORY[item.phase]);
  const preferred = el.dataset.expansionPreference;
  const expanded = expandable && preferred !== "collapsed";

  el.className = `vera-item vera-activity vera-activity--${category.key}`;
  el.dataset.activityId = item.id;
  el.dataset.activityKind = kind;
  el.classList.toggle("is-expandable", expandable);

  const header = document.createElement("div");
  header.className = "vera-activity__header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "vera-activity__toggle";
  toggle.disabled = !expandable;
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute(
    "aria-label",
    expandable ? `${expanded ? "折叠" : "展开"}${kindMeta.label}` : `${kindMeta.label}摘要`,
  );
  toggle.append(createVectorIcon(kindMeta.icon));

  const summary = document.createElement("span");
  summary.className = "vera-activity__summary";
  summary.textContent = activitySummary(item);
  summary.title = summary.textContent;
  toggle.append(summary);
  header.append(toggle);

  const detail = document.createElement("div");
  detail.className = "vera-activity__detail";
  detail.textContent = expandable ? detailText : "";
  detail.hidden = !expanded;

  toggle.addEventListener("click", () => {
    if (!expandable) return;
    const next = !el.classList.contains("is-expanded");
    toggle.setAttribute("aria-label", `${next ? "折叠" : "展开"}${kindMeta.label}`);
    toggleExpanded(el, next);
  });

  el.replaceChildren(header, detail);
  if (expanded) el.classList.add("is-expanded");
}

export function renderActivity(item, context) {
  const el = document.createElement("div");
  applyActivity(el, item, context);
  return el;
}
