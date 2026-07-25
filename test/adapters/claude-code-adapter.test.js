import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClaudeCodeAdapter } from "../../src/adapters/claude-code-adapter.js";

const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ args, input }) + "\\n");
  const resumeAt = args.indexOf("--resume");
  const session = resumeAt === -1 ? "claude-session-1" : args[resumeAt + 1];
  const events = [
    { type: "system", subtype: "init", session_id: session },
    { type: "stream_event", session_id: session, event: {
      type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "公开推理" },
    } },
    { type: "stream_event", session_id: session, event: {
      type: "content_block_start", index: 1,
      content_block: { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    } },
    { type: "user", session_id: session, message: {
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "read ok" }],
    } },
    { type: "stream_event", session_id: session, event: {
      type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "完成" },
    } },
    { type: "result", subtype: "success", is_error: false, result: "完成", session_id: session },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
});
`;

function context(binary, overrides = {}) {
  const activities = [];
  const deltas = [];
  const persisted = [];
  return {
    ctx: {
      runtime: {
        kind: "cli",
        provider: "claude-code",
        model: "claude-sonnet",
        connection: { command: binary, args: [], secretRef: null },
      },
      workspacePath: process.cwd(),
      prompt: { text: "inspect" },
      sessionMode: "main",
      providerBinding: null,
      signal: new AbortController().signal,
      onActivity: (activity) => activities.push(activity),
      onDelta: (delta) => deltas.push(delta),
      persistProviderBinding: async (providerState, ifVersion) => {
        persisted.push({ providerState, ifVersion });
        return { version: 1, providerState };
      },
      ...overrides,
    },
    activities,
    deltas,
    persisted,
  };
}

test("Claude Code stream-json maps public thinking, tool lifecycle, text, and resume binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vera-claude-code-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "claude");
  await writeFile(binary, FAKE_SOURCE, { mode: 0o755 });
  const adapter = createClaudeCodeAdapter({ config: { binary, permissionMode: "auto" } });
  t.after(() => adapter.shutdown());

  const first = context(binary);
  const firstResult = await adapter.run(first.ctx);
  assert.deepEqual(firstResult, {
    content: "完成",
    providerBinding: { version: 1, providerState: { sessionId: "claude-session-1" } },
  });
  assert.deepEqual(first.deltas, ["完成"]);
  assert.deepEqual(first.persisted, [{
    providerState: { sessionId: "claude-session-1" },
    ifVersion: null,
  }]);
  assert.equal(first.activities.find((item) => item.phase === "thinking")?.detail, "公开推理");
  const tool = first.activities.filter((item) => item.callId === "tool-1").at(-1);
  assert.equal(tool.label, "Read");
  assert.equal(tool.toolStatus, "completed");
  assert.match(tool.detail, /read ok/u);

  const second = context(binary, { providerBinding: firstResult.providerBinding });
  const secondResult = await adapter.run(second.ctx);
  assert.deepEqual(secondResult, { content: "完成", providerBinding: firstResult.providerBinding });
  assert.deepEqual(second.persisted, []);
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls[0].args.includes("--resume"), false);
  assert.deepEqual(calls[1].args.slice(calls[1].args.indexOf("--resume"), calls[1].args.indexOf("--resume") + 2), [
    "--resume",
    "claude-session-1",
  ]);
  assert.equal(calls[0].input, "inspect");
});

test("Claude Code rejects mismatched runtime before spawning", async () => {
  const adapter = createClaudeCodeAdapter();
  const input = context("/tmp/not-claude");
  await assert.rejects(() => adapter.run({
    ...input.ctx,
    runtime: { ...input.ctx.runtime, provider: "codex" },
  }), (error) => error.code === "unavailable");
});
