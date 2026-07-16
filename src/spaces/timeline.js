// 时间线查询：Message / Activity / Approval 三种 itemType 混排倒序分页
// （api-contract.md 三、GET /api/spaces/:id/timeline）。

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function getTimeline(store, spaceId, { spaceSessionId, before, limit = 50 } = {}) {
  const resolvedSpaceSessionId = spaceSessionId ?? store.find("spaces", spaceId)?.activeSpaceSessionId;
  const items = [
    ...store.list("messages").filter((m) => m.spaceId === spaceId && m.spaceSessionId === resolvedSpaceSessionId).map((m) => ({ ...m, itemType: "message" })),
    ...store.list("activities").filter((a) => a.spaceId === spaceId && a.spaceSessionId === resolvedSpaceSessionId).map((a) => ({ ...a, itemType: "activity" })),
    ...store.list("approvals").filter((a) => a.spaceId === spaceId && a.spaceSessionId === resolvedSpaceSessionId).map((a) => ({ ...a, itemType: "approval" })),
  ];

  items.sort((a, b) => b._seq - a._seq); // 倒序：最新在前

  let start = 0;
  if (before) {
    const idx = items.findIndex((item) => item.id === before);
    start = idx === -1 ? 0 : idx + 1;
  }

  const page = items.slice(start, start + limit).map(stripInternal);
  const pageItemIds = new Set(page.map((item) => item.id));
  const pageRunIds = new Set(page.map((item) => item.runId).filter(Boolean));
  const runs = store.list("runs")
    .filter((run) => run.spaceId === spaceId && run.spaceSessionId === resolvedSpaceSessionId)
    .filter((run) => pageRunIds.has(run.id) || pageItemIds.has(run.triggerMessageId) ||
      (run.replyMessageIds ?? []).some((id) => pageItemIds.has(id)))
    .sort((left, right) => (left._seq ?? 0) - (right._seq ?? 0))
    .map(stripInternal);
  const spaceSession = resolvedSpaceSessionId ? store.find("spaceSessions", resolvedSpaceSessionId) : null;
  return { spaceSession: spaceSession ? stripInternal(spaceSession) : null, items: page, runs };
}
