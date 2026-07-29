import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
};
const prompt = value("--print") || "";
const model = value("--model") || "";
const prior = value("--conversation");
const calls = path.join(__dirname, "calls.jsonl");
let previousCalls = [];
try {
  previousCalls = fs.readFileSync(calls, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
} catch {}
fs.appendFileSync(calls, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\\n");
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const conversation = prior === "stale-conversation" ||
  (model === "fake-rotate" && prior && !previousCalls.some((call) =>
    call.args?.includes("--conversation") && call.args?.includes("fake-rotate")))
  ? "fresh-after-stale"
  : prior || "agy-conversation-1";
if (model === "fake-hang") {
  process.on("SIGTERM", () => {
    write({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "context canceled", usage: {} } });
    process.exit(0);
  });
  setInterval(() => {}, 1000);
  return;
}
if (model === "fake-bad-json") {
  process.stdout.write("{bad json\\n");
  return;
}
const init = {
  event: "init",
  conversation_id: conversation,
  init: { model, cwd: model === "fake-wrong-cwd" ? "/tmp" : process.cwd(), permission_mode: "request-review" },
};
if (model === "fake-fragmented") {
  const line = JSON.stringify(init) + "\\n";
  process.stdout.write(line.slice(0, 11));
  process.stdout.write(line.slice(11));
} else {
  write(init);
}
if (prior === "stale-conversation") {
  write({ event: "step_update", step_update: {
    conversation_id: conversation, step_index: 1, state: "DONE",
    step_type: "agent_response", text_delta: "MUST_NOT_ESCAPE",
  } });
  write({ event: "result", result: {
    conversation_id: conversation, status: "SUCCESS", response: "MUST_NOT_ESCAPE", usage: { input_tokens: 1 },
  } });
  return;
}
if (model === "fake-provider-error") {
  write({ event: "result", result: {
    conversation_id: conversation, status: "ERROR", response: "",
    error: "verify at https://accounts.google.com/secret-link",
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  } });
  return;
}
if (model === "fake-quota-error") {
  write({ event: "result", result: {
    conversation_id: conversation, status: "ERROR", response: "",
    error: {
      code: "quota_exhausted",
      message: "credits exhausted for user@example.com; resets in 2h",
    },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  } });
  return;
}
if (model === "fake-rate-error") {
  write({ event: "result", result: {
    conversation_id: conversation, status: "ERROR", response: "",
    error: {
      type: "rate_limit_exceeded",
      message: "Too many requests. Retry after 30 seconds. https://example.invalid/private?token=SECRET",
    },
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  } });
  return;
}
const writePermissionDenied = (error = {
  name: "PermissionUserDeniedError",
  message: "User denied permission to run command: printf VERA_PERMISSION_PROBE",
}) => {
  write({ event: "step_update", step_update: {
    conversation_id: conversation, step_index: 1, state: "ACTIVE", step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { command: "printf VERA_PERMISSION_PROBE" } },
  } });
  write({ event: "step_update", step_update: {
    conversation_id: conversation, step_index: 1, state: "ERROR", step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", error },
  } });
  process.stderr.write("Tool request was soft-denied; add an allow rule to permit it.\\n");
  write({ event: "result", result: {
    conversation_id: conversation, status: "SUCCESS", response: "",
    usage: { input_tokens: prior ? 12000 : 11000, output_tokens: 0, total_tokens: prior ? 12000 : 11000 },
  } });
};
if (model === "fake-permission-loop" ||
    (prompt.includes("TRIGGER_PERMISSION_DENIAL") && !prompt.startsWith("Vera control notice:"))) {
  writePermissionDenied();
  return;
}
if (prompt.startsWith("Vera control notice:")) {
  write({ event: "step_update", step_update: {
    conversation_id: conversation, step_index: 2, state: "DONE",
    step_type: "agent_response", text_delta: "AGY_PERMISSION_CONTINUED",
  } });
  write({ event: "result", result: {
    conversation_id: conversation, status: "SUCCESS", response: "AGY_PERMISSION_CONTINUED",
    usage: { input_tokens: 12000, output_tokens: 3, total_tokens: 12003 },
  } });
  return;
}
if (prompt.includes("TRIGGER_FILESYSTEM_PERMISSION_ERROR")) {
  writePermissionDenied("bash: /root/private: Permission denied");
  return;
}
if (model === "fake-no-result") return;
if (model === "fake-fallback") {
  write({ event: "result", result: {
    conversation_id: conversation, status: "SUCCESS", response: "FALLBACK_OK",
    usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
  } });
  return;
}
write({ event: "step_update", step_update: {
  conversation_id: conversation, step_index: 1, state: "ACTIVE", step_type: "tool",
  tool_name: "run_command", tool_info: { name: "run_command", parameters: { command: "pwd" } },
} });
write({ event: "step_update", step_update: {
  conversation_id: conversation, step_index: 1, state: "DONE", step_type: "tool",
  tool_name: "run_command", tool_info: { name: "run_command", output: process.cwd() },
} });
const reply = prior ? "AGY_RESUME_OK" : "AGY_CHAT_OK";
write({ event: "step_update", step_update: {
  conversation_id: conversation, step_index: 2, state: "DONE",
  step_type: "agent_response", text_delta: reply,
} });
write({ event: "result", result: {
  conversation_id: conversation, status: "SUCCESS", response: reply,
  usage: {
    input_tokens: prior ? 24000 : 10000,
    output_tokens: 4,
    thinking_tokens: 2,
    cache_read_tokens: prior ? 8000 : 0,
    total_tokens: prior ? 24006 : 10006,
  },
} });
`;

export async function createFakeAntigravity(t) {
  const root = await mkdtemp(join(tmpdir(), "vera-antigravity-"));
  const close = () => rm(root, { recursive: true, force: true });
  t?.after(close);
  const binary = join(root, "agy");
  await writeFile(binary, SOURCE, { mode: 0o755 });
  return {
    binary,
    close,
    async calls() {
      try {
        return (await readFile(join(root, "calls.jsonl"), "utf8"))
          .trim().split("\n").filter(Boolean).map(JSON.parse);
      } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
      }
    },
  };
}
