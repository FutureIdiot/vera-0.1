function inline(value) {
  return String(value ?? "").replace(/([\\`*_[\]<>#])/gu, "\\$1").trim();
}

function time(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "时间未知";
}

function messageAuthor(item, accountNames) {
  if (item.author?.type !== "account") return "User";
  return item.accountNameSnapshot ?? accountNames.get(item.author.accountId) ?? "Account";
}

function attachmentLines(attachments = []) {
  if (attachments.length === 0) return [];
  return [
    "",
    "附件：",
    ...attachments.map((attachment) => {
      const size = Number.isFinite(attachment.sizeBytes) ? `${attachment.sizeBytes} bytes` : "大小未知";
      return `- ${inline(attachment.name || "附件")} · ${inline(attachment.mime || "application/octet-stream")} · ${size} · ${inline(attachment.state || "unavailable")} · ${inline(attachment.fileId)}`;
    }),
  ];
}

function itemSection(item, accountNames) {
  const createdAt = time(item.createdAt);
  if (item.itemType === "message") {
    const status = item.status && item.status !== "completed" ? ` · ${inline(item.status)}` : "";
    return [
      `## ${inline(messageAuthor(item, accountNames))}${status}`,
      "",
      createdAt,
      "",
      String(item.content ?? ""),
      ...attachmentLines(item.attachments),
    ].join("\n");
  }
  if (item.itemType === "activity") {
    const summary = item.summary ?? item.label ?? item.kind ?? item.phase ?? "过程记录";
    const detail = String(item.detail ?? "").trim();
    return [
      `## Activity · ${inline(summary)}`,
      "",
      createdAt,
      ...(detail ? ["", detail] : []),
    ].join("\n");
  }
  if (item.itemType === "approval") {
    const answer = item.answer ?? item.status ?? "pending";
    return [
      `## Approval · ${inline(answer)}`,
      "",
      createdAt,
      "",
      String(item.prompt ?? ""),
    ].join("\n");
  }
  if (item.itemType === "run-message") {
    return [
      `## Background work · ${inline(item.kind ?? "update")}`,
      "",
      createdAt,
      "",
      String(item.content ?? ""),
    ].join("\n");
  }
  return "";
}

export function formatTimelineMarkdown({
  space,
  spaceSessionId,
  items = [],
  accountNames = new Map(),
  exportedAt = new Date(),
} = {}) {
  const sections = [...items]
    .reverse()
    .map((item) => itemSection(item, accountNames))
    .filter(Boolean);
  return [
    `# ${inline(space?.name ?? "Vera Chat")}`,
    "",
    `- SpaceSession: ${inline(spaceSessionId)}`,
    `- Exported: ${time(exportedAt)}`,
    "",
    ...sections.flatMap((section, index) => index === 0 ? [section] : ["---", "", section]),
    "",
  ].join("\n");
}

export function timelineExportFilename(space, spaceSessionId) {
  const name = String(space?.name ?? "space")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .trim()
    .replace(/\s+/gu, "-")
    .slice(0, 60) || "space";
  return `vera-${name}-${spaceSessionId}.md`;
}

export function downloadTimelineMarkdown(filename, content) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
