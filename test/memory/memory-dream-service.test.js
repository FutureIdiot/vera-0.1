import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createMemoryVault } from "../../src/memory/memory.js";
import { createMemoryDreamService } from "../../src/memory/memory-dream-service.js";

const AGENT = "agt_dream01";

async function waitFor(service, jobId) {
  for (let count = 0; count < 200; count += 1) {
    const job = service.getJob(AGENT, jobId);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Dream job did not finish");
}

async function fixture(executor, fn) {
  const root = await mkdtemp(join(tmpdir(), "vera-dream-service-test-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  store.insert("agents", { id: AGENT, name: "Dream Owner" });
  const memory = createMemoryVault({ vaultPath: join(root, "vault") });
  const created = await memory.saveMemory(AGENT, {
    slug: "old-rule", type: "rule", description: "Old rule", content: "Old content.",
  });
  const service = createMemoryDreamService({
    store,
    memory,
    freezeTask: () => ({
      memoryTaskSnapshot: { ownerAgentId: AGENT, executorAgentId: AGENT, verificationId: "verified" },
      memoryProviderSnapshot: { providerId: "vera.markdown", bindingVersion: "one", configVersion: "one" },
    }),
    validateTaskSnapshot: async () => {},
    proposalExecutor: executor,
  });
  service.start();
  try { await fn({ service, memory, created, store }); }
  finally { await service.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
}

test("Dream job is idempotent, writes through one batch, and exposes only a safe summary", async () => {
  let calls = 0;
  let payloadKeys = null;
  await fixture(async ({ payload }) => {
    calls += 1;
    const target = payload.memories[0];
    payloadKeys = Object.keys(target).sort();
    return { proposals: [{
      action: "update", targetSlug: target.slug, targetVersion: target.version,
      description: "Maintained rule",
    }] };
  }, async ({ service, memory }) => {
    const first = await service.enqueue({ agentId: AGENT, trigger: "manual", requestId: "request-one" });
    const duplicate = await service.enqueue({ agentId: AGENT, trigger: "manual", requestId: "request-one" });
    assert.equal(duplicate.job.id, first.job.id);
    const done = await waitFor(service, first.job.id);
    assert.equal(done.status, "succeeded");
    assert.equal(done.result.updatedCount, 1);
    assert.equal(calls, 1);
    assert.deepEqual(payloadKeys, ["content", "derived", "description", "links", "slug", "sources", "status", "type", "version"]);
    assert.equal((await memory.getMemory(AGENT, "old-rule")).description, "Maintained rule");
    assert.equal((await memory.getMemory(AGENT, "old-rule")).content, "Old content.");
    for (const secretField of ["memorySnapshot", "memoryTaskSnapshot", "memoryProviderSnapshot", "proposals", "receipts"]) {
      assert.equal(secretField in done, false);
    }
  });
});

test("merge fails with write_conflict if its target is archived while the executor runs", async () => {
  let liveMemory;
  await fixture(async ({ payload }) => {
    const target = payload.memories.find((item) => item.slug === "old-rule");
    const other = payload.memories.find((item) => item.slug === "other-rule");
    await liveMemory.updateMemory(AGENT, target.slug, { ifMatch: target.version, status: "archived" });
    return { proposals: [{
      action: "merge", targetSlug: target.slug, targetVersion: target.version,
      sourceSlugs: [target.slug, other.slug],
      sourceVersions: { [target.slug]: target.version, [other.slug]: other.version },
      type: "rule", description: "Merged rule", content: "Old content.",
    }] };
  }, async ({ service, memory }) => {
    liveMemory = memory;
    await memory.saveMemory(AGENT, {
      slug: "other-rule", type: "rule", description: "Other rule", content: "Old content.",
    });
    const queued = await service.enqueue({ agentId: AGENT, trigger: "manual", requestId: "request-merge-conflict" });
    const done = await waitFor(service, queued.job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "write_conflict");
    assert.equal((await memory.getMemory(AGENT, "other-rule")).status, "active");
  });
});

test("invalid Dream proposals fail safely without changing Memory", async () => {
  await fixture(async ({ payload }) => ({ proposals: [{
    action: "update", targetSlug: payload.memories[0].slug,
    targetVersion: `sha256:${"f".repeat(64)}`, content: "Should not write.",
  }] }), async ({ service, memory, created }) => {
    const queued = await service.enqueue({ agentId: AGENT, trigger: "manual", requestId: "request-bad" });
    const done = await waitFor(service, queued.job.id);
    assert.equal(done.status, "failed");
    assert.equal(done.error.code, "invalid_proposal");
    assert.equal((await memory.getMemory(AGENT, "old-rule")).version, created.version);
  });
});

test("Dream service rejects a batch size above the 256-item contract limit", async () => {
  await fixture(async () => ({ proposals: [] }), async ({ store, memory }) => {
    assert.throws(() => createMemoryDreamService({ store, memory, batchSize: 257 }), /1 to 256/);
  });
});
