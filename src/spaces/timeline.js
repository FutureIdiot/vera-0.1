// 时间线查询：Message / Activity / Approval 三种 itemType 混排倒序分页
// （api-contract.md 三、GET /api/spaces/:id/timeline）。

function stripInternal({ _seq, ...rest }) {
  return rest;
}

export function getTimeline(store, spaceId, { before, limit = 50 } = {}) {
  const items = [
    ...store.list("messages").filter((m) => m.spaceId === spaceId).map((m) => ({ ...m, itemType: "message" })),
    ...store.list("activities").filter((a) => a.spaceId === spaceId).map((a) => ({ ...a, itemType: "activity" })),
    ...store.list("approvals").filter((a) => a.spaceId === spaceId).map((a) => ({ ...a, itemType: "approval" })),
  ];

  items.sort((a, b) => b._seq - a._seq); // 倒序：最新在前

  let start = 0;
  if (before) {
    const idx = items.findIndex((item) => item.id === before);
    start = idx === -1 ? 0 : idx + 1;
  }

  const page = items.slice(start, start + limit).map(stripInternal);
  return { items: page };
}
