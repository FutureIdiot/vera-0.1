import test from "node:test";
import assert from "node:assert/strict";

import {
  inferToolActivityKind,
  normalizeActivityKind,
  summarizeReasoning,
  summarizeToolActivity,
} from "../../src/core/activity-events.js";

test("provider tool names map into Vera's stable Activity kinds", () => {
  assert.equal(inferToolActivityKind("command_execution"), "command");
  assert.equal(inferToolActivityKind("Read"), "read");
  assert.equal(inferToolActivityKind("apply_patch"), "edit");
  assert.equal(inferToolActivityKind("web_search"), "search");
  assert.equal(inferToolActivityKind("update_plan"), "plan");
  assert.equal(inferToolActivityKind("context_automatically_compacted"), "compact");
  assert.equal(inferToolActivityKind("custom_provider_tool"), "tool");
  assert.equal(inferToolActivityKind("thread_update"), "tool");
  assert.equal(inferToolActivityKind("large_context_tool"), "tool");
  assert.equal(normalizeActivityKind("unknown", "status"), "status");
});

test("Activity summaries describe public content or safe actions", () => {
  assert.equal(summarizeReasoning("  比较两个实现\n并验证契约  "), "比较两个实现 并验证契约");
  assert.equal(summarizeToolActivity({
    kind: "command",
    name: "command_execution",
    status: "completed",
  }), "已运行命令");
  assert.equal(summarizeToolActivity({
    name: "Read",
    status: "running",
  }), "正在读取文件");
});
