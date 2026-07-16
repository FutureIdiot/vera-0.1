import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "../../src/memory/memory.js";
import {
  chunkDigestMessages, countUnicodeCodePoints, resolveDigestRange, resolveIncrementalDigestRange,
} from "../../src/memory/memory-digest-range.js";
import { deriveFactHashes, validateDigestProposals } from "../../src/memory/memory-proposals.js";
import { createMemoryDigestService } from "../../src/memory/memory-digest-service.js";

const AGENT = "agt_alpha";
const SPACE = "spc_alpha";
const SPACE_SESSION = "sps_alpha";

function createFakeStore(records = {}) {
  const data = {
    spaces: records.spaces ?? [{ id: SPACE, seats: [{ agentId: AGENT, blockAgentIds: ["agt_blocked"] }] }],
    messages: records.messages ?? [],
    memoryDigestJobs: records.memoryDigestJobs ?? [],
  };
  let seq = Math.max(0, ...Object.values(data).flat().map((item) => item._seq ?? 0));
  return {
    list(name) { if (!Array.isArray(data[name])) throw new Error(`unknown store collection: ${name}`); return data[name]; },
    find(name, id) { return this.list(name).find((item) => item.id === id) ?? null; },
    insert(name, record) { const value = { ...record, _seq: ++seq }; this.list(name).push(value); return value; },
    update(name, id, patch) {
      const collection = this.list(name);
      const index = collection.findIndex((item) => item.id === id);
      if (index < 0) return null;
      collection[index] = { ...collection[index], ...patch };
      return collection[index];
    },
  };
}

function message(id, seq, content, overrides = {}) {
  return {
    id, _seq: seq, spaceId: SPACE, spaceSessionId: SPACE_SESSION, status: "completed", content,
    author: { type: "user" }, target: { type: "broadcast" },
    createdAt: `2026-07-13T00:00:0${seq}.000Z`, ...overrides,
  };
}

function waitForJob(service, jobId, statuses = ["succeeded", "failed", "cancelled"], timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const job = service.getJob(AGENT, jobId);
      if (statuses.includes(job.status)) return resolve(job);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${jobId}; status=${job.status}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function withService(messages, executor, fn, jobs = []) {
  const dir = await mkdtemp(join(tmpdir(), "vera-digest-test-"));
  const store = createFakeStore({ messages, memoryDigestJobs: jobs });
  const memory = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
  });
  const service = createMemoryDigestService({ store, memory, proposalExecutor: executor, chunkMaxChars: 12 });
  try { await fn({ store, memory, service }); }
  finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
}

test("range counts Unicode code points, chunks deterministically, and filters the Agent view", () => {
  const messages = [
    message("msg_user", 1, "A😀"),
    message("msg_blocked", 2, "hidden", { author: { type: "agent", agentId: "agt_blocked" } }),
    message("msg_direct_other", 3, "private", { target: { type: "direct", agentIds: ["agt_other"] } }),
    message("msg_direct_me", 4, "visible", { author: { type: "agent", agentId: "agt_blocked" }, target: { type: "direct", agentIds: [AGENT] } }),
    message("msg_own", 5, "own", { author: { type: "agent", agentId: AGENT }, target: { type: "direct", agentIds: ["agt_other"] } }),
  ];
  const store = createFakeStore({ messages });
  const result = resolveDigestRange({ store, agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, fromMessageId: "msg_user", toMessageId: "msg_own" });
  assert.deepEqual(result.messages.map((item) => item.id), ["msg_user", "msg_direct_me", "msg_own"]);
  assert.equal(result.range.charCount, 12);
  assert.equal(countUnicodeCodePoints("A😀"), 2);
  const first = chunkDigestMessages(result.messages, { maxChars: 8 });
  const second = chunkDigestMessages(result.messages, { maxChars: 8 });
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((chunk) => chunk.messageCount), [1, 1, 1]);
});

test("incremental watermark does not rewind when later visibility rules hide its boundary Message", () => {
  const messages = [
    message("msg_one", 1, "visible one"),
    message("msg_two", 2, "agent message", { author: { type: "agent", agentId: "agt_blocked" } }),
    message("msg_three", 3, "visible three"),
  ];
  const store = createFakeStore({ messages });
  const jobs = [{
    agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "incremental", status: "succeeded",
    range: { toMessageId: "msg_two", toSeq: 2 },
  }];
  const resolved = resolveIncrementalDigestRange({ store, jobs, agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION });
  assert.deepEqual(resolved.messages.map((item) => item.id), ["msg_three"]);
});

test("digest ranges and incremental watermarks are isolated by SpaceSession", () => {
  const previous = "sps_previous";
  const messages = [
    message("msg_old_one", 1, "old one", { spaceSessionId: previous }),
    message("msg_old_two", 2, "old two", { spaceSessionId: previous }),
    message("msg_new", 3, "new window"),
  ];
  const store = createFakeStore({ messages });
  const jobs = [{
    agentId: AGENT, spaceId: SPACE, spaceSessionId: previous, mode: "incremental", status: "succeeded",
    range: { toMessageId: "msg_old_one", toSeq: 1 },
  }];
  assert.deepEqual(resolveIncrementalDigestRange({
    store, jobs, agentId: AGENT, spaceId: SPACE, spaceSessionId: previous,
  }).messages.map((item) => item.id), ["msg_old_two"]);
  assert.deepEqual(resolveIncrementalDigestRange({
    store, jobs, agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION,
  }).messages.map((item) => item.id), ["msg_new"]);
  assert.throws(() => resolveDigestRange({
    store, agentId: AGENT, spaceId: SPACE, spaceSessionId: previous,
    fromMessageId: "msg_old_one", toMessageId: "msg_new",
  }), /SpaceSession/);
});

test("executor chunks expose only Message evidence fields and omit internal chunk metadata", async () => {
  const messages = [message("msg_one", 1, "Remember this durable rule")];
  let received;
  await withService(messages, async (input) => {
    received = input.chunks;
    return { proposals: [{ action: "skip", evidenceMessageIds: ["msg_one"], skipReason: "no_reusable_fact" }] };
  }, async ({ service }) => {
    const queued = service.enqueue({
      agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual",
      fromMessageId: "msg_one", toMessageId: "msg_one",
    });
    const job = await waitForJob(service, queued.id);
    assert.equal(job.status, "succeeded");
  });
  assert.deepEqual(received, [{ messages: [{
    messageId: "msg_one",
    author: { type: "user" },
    target: { type: "broadcast" },
    content: "Remember this durable rule",
    createdAt: "2026-07-13T00:00:01.000Z",
  }] }]);
});

test("fact address ignores qualifier order while fact value remains separate", () => {
  const left = deriveFactHashes(AGENT, { subject: " Vera ", relation: "USES", qualifiers: [" Scope A ", "Project"], value: "JSON" });
  const right = deriveFactHashes(AGENT, { subject: "vera", relation: "uses", qualifiers: ["project", "scope a"], value: "Markdown" });
  assert.equal(left.factAddressHash, right.factAddressHash);
  assert.notEqual(left.factValueHash, right.factValueHash);
});

test("all proposals are validated before apply and invalid evidence leaves the vault unchanged", async () => {
  const messages = [message("msg_one", 1, "Remember this")];
  await withService(messages, async () => ({ proposals: [
    {
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "project", relation: "format", qualifiers: [], value: "markdown" },
      suggestedSlug: "project-format", type: "decision", description: "Project format is Markdown", content: "Use Markdown.",
    },
    { action: "skip", evidenceMessageIds: ["msg_outside"], skipReason: "no_reusable_fact" },
  ] }), async ({ service, memory }) => {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const done = await waitForJob(service, job.id);
    assert.equal(done.status, "failed");
    assert.deepEqual(await memory.listMemories(AGENT), []);
  });
});

test("semantic target preflight also happens before the first Memory write", async () => {
  const messages = [message("msg_one", 1, "Remember this")];
  await withService(messages, async () => ({ proposals: [
    {
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "project", relation: "format", qualifiers: [], value: "markdown" },
      suggestedSlug: "project-format", type: "decision", description: "Project format is Markdown", content: "Use Markdown.",
    },
    {
      action: "update", evidenceMessageIds: ["msg_one"],
      fact: { subject: "missing", relation: "target", qualifiers: [], value: "value" },
      content: "Cannot be targeted.",
    },
  ] }), async ({ service, memory }) => {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    assert.equal((await waitForJob(service, job.id)).status, "failed");
    assert.deepEqual(await memory.listMemories(AGENT), []);
  });
});

test("same persisted fact keeps its slug, merges sources, and duplicate enqueue returns one job", async () => {
  const messages = [message("msg_one", 1, "Use markdown"), message("msg_two", 2, "Please keep using Markdown")];
  let call = 0;
  await withService(messages, async () => {
    call += 1;
    return { proposals: [{
      action: "create", evidenceMessageIds: [call === 1 ? "msg_one" : "msg_two"],
      fact: { subject: "project", relation: "storage format", qualifiers: ["vera"], value: "markdown" },
      suggestedSlug: call === 1 ? "project-format" : "different-model-slug",
      type: "decision", description: "Project storage uses Markdown", content: "Use Markdown as the storage format.",
    }] };
  }, async ({ service, memory }) => {
    const first = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    assert.equal(service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" }).id, first.id);
    assert.equal((await waitForJob(service, first.id)).status, "succeeded");
    const second = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_two", toMessageId: "msg_two" });
    assert.equal((await waitForJob(service, second.id)).status, "succeeded");
    assert.deepEqual((await memory.listMemories(AGENT)).map((item) => item.slug), ["project-format"]);
    assert.deepEqual((await memory.getMemory(AGENT, "project-format")).sources.map((source) => source.messageId), ["msg_one", "msg_two"]);
  });
});

test("targetFactId matches the same fact across different wording and semantic slots", async () => {
  const messages = [message("msg_one", 1, "Use Chinese"), message("msg_two", 2, "默认使用中文")];
  let targetFactId;
  let call = 0;
  await withService(messages, async ({ facts }) => {
    call += 1;
    if (call === 1) return { proposals: [{
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "response language", relation: "uses", qualifiers: ["default"], value: "chinese" },
      suggestedSlug: "response-language", type: "preference", description: "Default responses use Chinese", content: "Use Chinese by default.",
    }] };
    assert.equal(facts[0].factId, targetFactId);
    assert.equal(facts[0].type, "preference");
    return { proposals: [{
      action: "update", evidenceMessageIds: ["msg_two"], targetFactId,
      fact: { subject: "回复语言", relation: "默认为", qualifiers: ["日常对话"], value: "chinese" },
      type: "preference", description: "默认使用中文回复", content: "默认使用中文回复。",
    }] };
  }, async ({ service, memory }) => {
    const first = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const firstDone = await waitForJob(service, first.id);
    targetFactId = firstDone.result.facts[0].factId;
    const second = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_two", toMessageId: "msg_two" });
    assert.equal((await waitForJob(service, second.id)).status, "succeeded");
    assert.deepEqual((await memory.listMemories(AGENT)).map((item) => item.slug), ["response-language"]);
    assert.equal((await memory.getMemory(AGENT, "response-language")).content, "默认使用中文回复。");
  });
});

test("an unmapped manual Memory can be adopted without creating a duplicate slug", async () => {
  const messages = [message("msg_one", 1, "Keep the existing manual rule")];
  await withService(messages, async ({ facts }) => {
    const manual = facts.find((fact) => fact.slug === "manual-rule");
    assert.equal(manual.unmapped, true);
    assert.equal(manual.factId, null);
    assert.equal(manual.type, "decision");
    return { proposals: [{
      action: "update", evidenceMessageIds: ["msg_one"], targetMemorySlug: "manual-rule",
      fact: { subject: "manual rule", relation: "state", qualifiers: [], value: "kept" },
      type: "decision", description: "Manual rule remains active", content: "Keep the manual rule.",
    }] };
  }, async ({ service, memory }) => {
    await memory.saveMemory(AGENT, {
      slug: "manual-rule", type: "decision", description: "Manual entry", content: "Original manual body.",
    });
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const done = await waitForJob(service, job.id);
    assert.equal(done.status, "succeeded");
    assert.deepEqual((await memory.listMemories(AGENT)).map((item) => item.slug), ["manual-rule"]);
    assert.equal((await memory.getMemory(AGENT, "manual-rule")).content, "Keep the manual rule.");
  });
});

test("fact catalogs remain isolated when two Agents use the same slug", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vera-digest-agent-isolation-"));
  const beta = "agt_beta";
  const messages = [message("msg_alpha", 1, "Alpha evidence")];
  const betaFact = {
    agentId: beta,
    factId: "fct_0123456789abcdef",
    factAddressHash: "sha256:beta-address",
    factValueHash: "sha256:beta-value",
    addressSlots: { subject: "beta secret", relation: "is", qualifiers: [] },
    slug: "same-slug",
    version: "sha256:old",
  };
  const store = createFakeStore({
    spaces: [
      { id: SPACE, seats: [{ agentId: AGENT }] },
      { id: "spc_beta", seats: [{ agentId: beta }] },
    ],
    messages,
    memoryDigestJobs: [{
      id: "mdj_beta", agentId: beta, spaceId: "spc_beta", mode: "range", status: "succeeded",
      result: { facts: [betaFact], operations: [] },
    }],
  });
  const memory = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
  });
  await memory.saveMemory(AGENT, { slug: "same-slug", type: "fact", description: "Alpha manual", content: "Alpha body." });
  let receivedFacts;
  const service = createMemoryDigestService({
    store,
    memory,
    proposalExecutor: async ({ facts }) => {
      receivedFacts = facts;
      return { proposals: [{ action: "skip", evidenceMessageIds: [], skipReason: "no_reusable_fact" }] };
    },
  });
  try {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_alpha", toMessageId: "msg_alpha" });
    assert.equal((await waitForJob(service, job.id)).status, "succeeded");
    assert.equal(receivedFacts.some((fact) => fact.factId === betaFact.factId), false);
    assert.equal(receivedFacts.find((fact) => fact.slug === "same-slug").unmapped, true);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("stale fact receipts cannot overwrite an owner edit", async () => {
  const messages = [message("msg_one", 1, "Use JSON"), message("msg_two", 2, "Keep JSON")];
  let targetFactId;
  let call = 0;
  await withService(messages, async () => {
    call += 1;
    if (call === 1) return { proposals: [{
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "format", relation: "is", qualifiers: [], value: "json" },
      suggestedSlug: "format-rule", type: "decision", description: "Format is JSON", content: "Use JSON.",
    }] };
    return { proposals: [{
      action: "update", evidenceMessageIds: ["msg_two"], targetFactId,
      fact: { subject: "format", relation: "is", qualifiers: [], value: "json" },
      type: "decision", description: "Digest overwrite", content: "Digest overwrite.",
    }] };
  }, async ({ service, memory }) => {
    const first = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const firstDone = await waitForJob(service, first.id);
    targetFactId = firstDone.result.facts[0].factId;
    const current = await memory.getMemory(AGENT, "format-rule");
    await memory.updateMemory(AGENT, "format-rule", { ifMatch: current.version, content: "Owner edited authority." });
    const second = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_two", toMessageId: "msg_two" });
    const failed = await waitForJob(service, second.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "write_conflict");
    assert.equal((await memory.getMemory(AGENT, "format-rule")).content, "Owner edited authority.");
  });
});

test("two different facts cannot overwrite one suggested slug in the same job", async () => {
  const messages = [message("msg_one", 1, "Two facts")];
  await withService(messages, async () => ({ proposals: [
    {
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "one", relation: "is", qualifiers: [], value: "first" },
      suggestedSlug: "shared-slug", type: "fact", description: "First fact", content: "First.",
    },
    {
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "two", relation: "is", qualifiers: [], value: "second" },
      suggestedSlug: "shared-slug", type: "fact", description: "Second fact", content: "Second.",
    },
  ] }), async ({ service, memory }) => {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    assert.equal((await waitForJob(service, job.id)).status, "failed");
    assert.deepEqual(await memory.listMemories(AGENT), []);
  });
});

test("supersede updates the same slug with explicit correction evidence and archive/skip are auditable", async () => {
  const messages = [
    message("msg_old", 1, "Use JSON"),
    message("msg_fix", 2, "纠正：不再使用 JSON，改为 Markdown"),
    message("msg_archive", 3, "This old rule is obsolete"),
  ];
  let phase = 0;
  let targetFactId;
  await withService(messages, async () => {
    phase += 1;
    if (phase === 1) return { proposals: [{
      action: "create", evidenceMessageIds: ["msg_old"], fact: { subject: "project", relation: "format", qualifiers: [], value: "json" },
      suggestedSlug: "project-format", type: "decision", description: "Project format is JSON", content: "Use JSON.",
    }] };
    if (phase === 2) return { proposals: [{
      action: "supersede", evidenceMessageIds: ["msg_fix"], targetFactId,
      fact: { subject: "project", relation: "format", qualifiers: [], value: "markdown" },
      type: "decision", description: "Project format is Markdown", content: "Use Markdown.",
    }] };
    return { proposals: [
      { action: "archive", evidenceMessageIds: ["msg_archive"], targetFactId },
      { action: "skip", evidenceMessageIds: [], skipReason: "no_reusable_fact" },
    ] };
  }, async ({ service, memory }) => {
    const first = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_old", toMessageId: "msg_old" });
    const firstDone = await waitForJob(service, first.id);
    assert.equal(firstDone.status, "succeeded");
    targetFactId = firstDone.result.facts[0].factId;
    const second = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_fix", toMessageId: "msg_fix" });
    assert.equal((await waitForJob(service, second.id)).status, "succeeded");
    const third = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_archive", toMessageId: "msg_archive" });
    assert.equal((await waitForJob(service, third.id)).status, "succeeded");
    const final = await memory.getMemory(AGENT, "project-format");
    assert.equal(final.content, "Use Markdown.");
    assert.equal(final.status, "archived");
    assert.deepEqual(final.sources.map((source) => source.messageId), ["msg_old", "msg_fix", "msg_archive"]);
  });
});

test("task unavailable fails with a stable safe code", async () => {
  const messages = [message("msg_one", 1, "Remember this")];
  await withService(messages, null, async ({ service }) => {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const done = await waitForJob(service, job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "memory_task_unavailable");
  });
});

test("executor failures expose only a stable safe error", async () => {
  const messages = [message("msg_one", 1, "Remember this")];
  await withService(messages, async () => {
    throw Object.assign(new Error("provider-secret-canary"), { code: "provider_error" });
  }, async ({ service }) => {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const done = await waitForJob(service, job.id);
    assert.deepEqual(done.error, { code: "executor_failed", message: "Memory digest executor failed." });
    assert.equal(JSON.stringify(done).includes("provider-secret-canary"), false);
  });
});

test("retry resumes a partially applied proposal batch without duplicate Memories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vera-digest-retry-test-"));
  const messages = [message("msg_one", 1, "First fact"), message("msg_two", 2, "Second fact")];
  const store = createFakeStore({ messages });
  const vault = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
  });
  let applyCount = 0;
  let failSecond = true;
  const memory = {
    ...vault,
    async applyOperation(operation) {
      applyCount += 1;
      if (failSecond && applyCount === 2) {
        failSecond = false;
        throw new Error("simulated second write failure");
      }
      return vault.applyOperation(operation);
    },
  };
  const executor = async () => ({ proposals: [
    {
      action: "create", evidenceMessageIds: ["msg_one"],
      fact: { subject: "first", relation: "is", qualifiers: [], value: "one" },
      suggestedSlug: "first-fact", type: "fact", description: "First fact", content: "First fact.",
    },
    {
      action: "create", evidenceMessageIds: ["msg_two"],
      fact: { subject: "second", relation: "is", qualifiers: [], value: "two" },
      suggestedSlug: "second-fact", type: "fact", description: "Second fact", content: "Second fact.",
    },
  ] });
  const service = createMemoryDigestService({ store, memory, proposalExecutor: executor });
  try {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_two" });
    assert.equal((await waitForJob(service, job.id)).status, "failed");
    service.retry(AGENT, job.id);
    assert.equal((await waitForJob(service, job.id)).status, "succeeded");
    assert.deepEqual((await vault.listMemories(AGENT)).map((item) => item.slug).sort(), ["first-fact", "second-fact"]);
    assert.equal((await vault.getMemory(AGENT, "first-fact")).sources.length, 1);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry recognizes an update committed just before its receipt was lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vera-digest-lost-receipt-"));
  const messages = [message("msg_one", 1, "Use JSON"), message("msg_two", 2, "Keep JSON with detail")];
  const store = createFakeStore({ messages });
  const vault = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
  });
  let throwAfterApply = false;
  const memory = {
    ...vault,
    async applyOperation(operation) {
      const result = await vault.applyOperation(operation);
      if (throwAfterApply) {
        throwAfterApply = false;
        throw new Error("simulated crash after vault commit");
      }
      return result;
    },
  };
  let targetFactId;
  let calls = 0;
  const service = createMemoryDigestService({
    store,
    memory,
    proposalExecutor: async () => {
      calls += 1;
      if (calls === 1) return { proposals: [{
        action: "create", evidenceMessageIds: ["msg_one"],
        fact: { subject: "format", relation: "is", qualifiers: [], value: "json" },
        suggestedSlug: "format-rule", type: "decision", description: "Format is JSON", content: "Use JSON.",
      }] };
      return { proposals: [{
        action: "update", evidenceMessageIds: ["msg_two"], targetFactId,
        fact: { subject: "format wording", relation: "remains", qualifiers: [], value: "json" },
        type: "decision", description: "Format remains JSON", content: "Use JSON with detail.",
      }] };
    },
  });
  try {
    const first = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    const firstDone = await waitForJob(service, first.id);
    targetFactId = firstDone.result.facts[0].factId;
    throwAfterApply = true;
    const second = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_two", toMessageId: "msg_two" });
    assert.equal((await waitForJob(service, second.id)).status, "failed");
    assert.equal((await vault.getMemory(AGENT, "format-rule")).content, "Use JSON with detail.");
    service.retry(AGENT, second.id);
    assert.equal((await waitForJob(service, second.id)).status, "succeeded");
    assert.equal(calls, 2, "retry must reuse the persisted proposal instead of rerunning the executor");
    assert.equal((await vault.getMemory(AGENT, "format-rule")).sources.length, 2);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("retry recognizes a manual adoption committed before its receipt was lost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vera-digest-adopt-lost-receipt-"));
  const messages = [message("msg_one", 1, "Adopt the manual rule")];
  const store = createFakeStore({ messages });
  const vault = createMemoryVault({
    vaultPath: join(dir, "vault"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
  });
  await vault.saveMemory(AGENT, {
    slug: "manual-rule", type: "decision", description: "Manual rule", content: "Manual body.",
  });
  let throwAfterApply = true;
  const memory = {
    ...vault,
    async applyOperation(operation) {
      const result = await vault.applyOperation(operation);
      if (throwAfterApply) {
        throwAfterApply = false;
        throw new Error("simulated crash after manual adoption");
      }
      return result;
    },
  };
  let calls = 0;
  const service = createMemoryDigestService({
    store,
    memory,
    proposalExecutor: async () => {
      calls += 1;
      return { proposals: [{
        action: "update", evidenceMessageIds: ["msg_one"], targetMemorySlug: "manual-rule",
        fact: { subject: "manual", relation: "state", qualifiers: [], value: "adopted" },
        type: "decision", description: "Manual rule adopted", content: "Adopted manual body.",
      }] };
    },
  });
  try {
    const job = service.enqueue({ agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION, mode: "range", trigger: "manual", fromMessageId: "msg_one", toMessageId: "msg_one" });
    assert.equal((await waitForJob(service, job.id)).status, "failed");
    service.retry(AGENT, job.id);
    assert.equal((await waitForJob(service, job.id)).status, "succeeded");
    assert.equal(calls, 1);
    assert.equal((await vault.getMemory(AGENT, "manual-rule")).content, "Adopted manual body.");
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("strict proposal validator rejects model-controlled identity and invalid supersede evidence", () => {
  const messages = [message("msg_one", 1, "ordinary statement")];
  assert.throws(() => validateDigestProposals({
    proposals: [{ action: "skip", evidenceMessageIds: [], skipReason: "none", agentId: "agt_evil" }],
    messages, agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION,
  }), /unknown proposal field/);
  assert.throws(() => validateDigestProposals({
    proposals: [{
      action: "supersede", evidenceMessageIds: ["msg_one"], targetFactId: "fct_0123456789abcdef",
      fact: { subject: "rule", relation: "value", qualifiers: [], value: "new" },
      type: "decision", description: "New rule", content: "New body",
    }],
    messages, agentId: AGENT, spaceId: SPACE, spaceSessionId: SPACE_SESSION,
  }), /explicit correction evidence/);
});
