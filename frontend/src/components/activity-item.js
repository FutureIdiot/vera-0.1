// Activity：思考链/工具执行记录，时间线正式成员，随 activity.updated 原地更新
// （docs/api-contract.md「Activity（时间线成员）」）。

export function applyActivity(el, item) {
  el.className = "vera-item vera-activity";
  const status = item.toolStatus ? ` [${item.toolStatus}]` : "";
  const label = item.label ? `: ${item.label}` : "";
  const detail = item.detail ? `\n${item.detail}` : "";
  el.textContent = `${item.phase}${label}${status}${detail}`;
  el.dataset.activityId = item.id;
}

export function renderActivity(item) {
  const el = document.createElement("div");
  applyActivity(el, item);
  return el;
}
