// Activity：provider公开reasoning / 工具执行记录，时间线正式成员，随
// activity.updated 原地更新（docs/api-contract.md「Activity」）。

import { createVectorIcon } from "./vector-icon.js";

const CATEGORY = {
  thinking: { key: "thinking", label: "Thinking", fallback: "正在思考" },
  tool: { key: "tool", label: "Tools", fallback: "正在执行工具" },
};

function singleLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function activitySummary(item) {
  const category = CATEGORY[item.phase];
  const parts = [];
  const label = singleLine(item.label);
  const summary = singleLine(item.summary) || singleLine(String(item.detail ?? "").split(/\r?\n/u)[0]);
  if (label && label.toLocaleLowerCase() !== category?.label.toLocaleLowerCase()) parts.push(label);
  if (summary && summary !== label) parts.push(summary);
  if (item.toolStatus && !parts.includes(item.toolStatus)) parts.push(singleLine(item.toolStatus));
  return parts.filter(Boolean).join(" · ") || category?.fallback || singleLine(item.phase) || "过程更新";
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
    label: singleLine(item.phase) || "Activity",
    fallback: "过程更新",
  };
  const detailText = String(item.detail ?? "").trim();
  const expandable = Boolean(canExpand && detailText && CATEGORY[item.phase]);
  const preferred = el.dataset.expansionPreference;
  const expanded = expandable && preferred !== "collapsed";

  el.className = `vera-item vera-activity vera-activity--${category.key}`;
  el.dataset.activityId = item.id;
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
    expandable ? `${expanded ? "折叠" : "展开"} ${category.label}` : `${category.label} 摘要`,
  );
  const toggleLabel = document.createElement("span");
  toggleLabel.textContent = category.label;
  toggle.append(toggleLabel, createVectorIcon("chevron-down"));

  const summary = document.createElement("span");
  summary.className = "vera-activity__summary";
  summary.textContent = activitySummary(item);
  summary.title = summary.textContent;
  header.append(toggle, summary);

  const detail = document.createElement("div");
  detail.className = "vera-activity__detail";
  detail.textContent = expandable ? detailText : "";
  detail.hidden = !expanded;

  toggle.addEventListener("click", () => {
    if (!expandable) return;
    const next = !el.classList.contains("is-expanded");
    toggle.setAttribute("aria-label", `${next ? "折叠" : "展开"} ${category.label}`);
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
