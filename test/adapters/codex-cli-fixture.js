import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFakeCodex(t) {
  const directory = await mkdtemp(join(tmpdir(), "vera-fake-codex-"));
  const binary = join(directory, "codex");
  const logPath = join(directory, "invocations.jsonl");
  const script = `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const logPath = ${JSON.stringify(logPath)};
await appendFile(logPath, JSON.stringify({ args, cwd: process.cwd(), input }) + "\\n");
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const model = valueAfter("-m") || "fake-default";
const outputPath = valueAfter("--output-last-message");
const schemaPath = valueAfter("--output-schema");
const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex >= 0;
const threadId = resumed ? args[resumeIndex + 1] : "thr_fake_1";

if (model === "fake-hang") await new Promise(() => setInterval(() => {}, 1000));
if (model === "fake-provider-error") {
  process.stderr.write("provider endpoint secret detail\\n");
  process.exit(2);
}
if (resumed && threadId === "stale-thread") {
  process.stderr.write("Error: thread/resume: thread/resume failed: no rollout found for thread id stale-thread (code -32600)\\n");
  process.exit(1);
}
if (model === "fake-bad-jsonl") {
  process.stdout.write("not-json\\n");
  process.exit(0);
}

process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
if (model === "fake-tool") {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "tool_1", type: "command_execution", command: "pwd", status: "completed" } }) + "\\n");
}

if (schemaPath) {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  if (model === "fake-bad-envelope") {
    await writeFile(outputPath, JSON.stringify({ wrong: [] }));
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ wrong: [] }) } }) + "\\n");
  } else {
    const evidenceMessageId = input.match(/"messageId":"([^"]+)"/)?.[1] || "msg_1";
    const proposal = model === "fake-proposal" ? [{
      action: "create", evidenceMessageIds: [evidenceMessageId],
      fact: { subject: "Vera", relation: "test port", qualifiers: [], value: "3210" },
      suggestedSlug: "vera-test-port", type: "rule",
      description: "Vera uses port 3210", content: "Use port 3210 for Vera tests."
    }] : [];
    const value = JSON.stringify({ proposals: proposal });
    await writeFile(outputPath, value);
    process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: value } }) + "\\n");
  }
  if (!schema?.properties?.proposals) process.exit(3);
} else {
  const text = resumed ? "CODEX_RESUME_OK" : "CODEX_CHAT_OK";
  await writeFile(outputPath, text);
  const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\\n";
  if (model === "fake-output-only") {
    // Deliberately omit the agent_message event so the adapter must use -o.
  } else if (model === "fake-fragmented") {
    process.stdout.write(line.slice(0, 17));
    await new Promise((resolve) => setTimeout(resolve, 5));
    process.stdout.write(line.slice(17));
  } else {
    process.stdout.write(line);
  }
}
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
`;
  await writeFile(binary, script, { mode: 0o700 });
  await chmod(binary, 0o700);
  t?.after?.(() => rm(directory, { recursive: true, force: true }));
  return {
    binary,
    directory,
    async readInvocations() {
      let text = "";
      try { text = await readFile(logPath, "utf8"); } catch {}
      return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
