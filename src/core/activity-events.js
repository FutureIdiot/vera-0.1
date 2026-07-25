const ACTIVITY_KINDS = new Set([
  "reasoning",
  "command",
  "read",
  "edit",
  "search",
  "plan",
  "compact",
  "tool",
  "status",
  "usage",
  "error",
]);

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase("und").replace(/[^a-z0-9]+/gu, "_");
}

export function singleLineSummary(value, fallback = "") {
  return String(value ?? "").replace(/\s+/gu, " ").trim() || fallback;
}

export function normalizeActivityKind(value, fallback = "status") {
  const kind = normalized(value);
  return ACTIVITY_KINDS.has(kind) ? kind : fallback;
}

export function inferToolActivityKind(value) {
  const name = normalized(value);
  const tokens = new Set(name.split("_").filter(Boolean));
  const has = (...values) => values.some((token) => tokens.has(token));
  if (has("reason", "reasoning", "think", "thinking")) return "reasoning";
  if (has("compact", "compacted", "compaction")) return "compact";
  if (has("plan", "todo")) return "plan";
  if (has("search", "query", "find", "grep", "ripgrep", "rg")) return "search";
  if (has("edit", "write", "patch", "replace") ||
      ["apply_patch", "applypatch", "file_change", "filechange", "create_file", "createfile"].includes(name)) return "edit";
  if (has("read", "view", "glob", "book") ||
      ["open_file", "openfile", "list_file", "listfile"].includes(name)) return "read";
  if (has("command", "shell", "bash", "terminal", "exec", "process")) return "command";
  if (has("usage", "token", "tokens")) return "usage";
  if (has("error", "failed", "failure")) return "error";
  return "tool";
}

function activityVerb(kind, status) {
  const completed = ["completed", "complete", "success", "succeeded", "done"].includes(status);
  const failed = ["error", "failed", "failure", "cancelled", "canceled", "timed_out"].includes(status);
  const pending = ["pending", "queued"].includes(status);
  const forms = {
    command: ["运行命令", "已运行命令", "命令执行失败", "准备运行命令"],
    read: ["读取文件", "已读取文件", "读取文件失败", "准备读取文件"],
    edit: ["编辑文件", "已编辑文件", "编辑文件失败", "准备编辑文件"],
    search: ["搜索信息", "已完成搜索", "搜索失败", "准备搜索"],
    plan: ["更新计划", "已更新计划", "更新计划失败", "准备更新计划"],
    compact: ["压缩上下文", "已压缩上下文", "压缩上下文失败", "准备压缩上下文"],
    usage: ["统计用量", "已更新用量", "用量统计失败", "准备统计用量"],
    tool: ["调用工具", "已调用工具", "工具调用失败", "准备调用工具"],
    status: ["处理请求", "已完成处理", "处理失败", "准备处理请求"],
    error: ["处理错误", "发生错误", "发生错误", "等待处理错误"],
  };
  const [runningText, completedText, failedText, pendingText] = forms[kind] ?? forms.tool;
  if (failed) return failedText;
  if (completed) return completedText;
  if (pending) return pendingText;
  return `正在${runningText}`;
}

export function summarizeToolActivity({ kind, name, status } = {}) {
  const resolvedKind = normalizeActivityKind(kind, inferToolActivityKind(name));
  return activityVerb(resolvedKind, normalized(status) || "running");
}

export function summarizeReasoning(value, fallback = "正在分析请求") {
  return singleLineSummary(value, fallback);
}
