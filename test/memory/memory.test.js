import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVault } from "../../src/memory/memory.js";

const AGENT_ID = "agt_test01";
const NOW = "2026-07-13T00:00:00.000Z";

function memoryInput(overrides = {}) {
  return {
    slug: "memory-rule",
    type: "decision",
    description: "one-line hook",
    content: "authoritative body",
    ...overrides,
  };
}

function operation({ kind, slug, value, patch, ifMatch, agentId = AGENT_ID, origin = "user-api" }) {
  return {
    operationId: `mop_test_${kind}_${slug}`,
    agentId,
    origin,
    kind,
    slug,
    ...(value === undefined ? {} : { value }),
    ...(patch === undefined ? {} : { patch }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    requestedAt: NOW,
  };
}

async function withVault(fn, { resolveSource, writeMemoryFile } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vera-memory-test-"));
  const vaultPath = join(dir, "vault");
  const agentPath = join(vaultPath, AGENT_ID);
  const vault = createMemoryVault({ vaultPath, resolveSource, writeMemoryFile });
  try {
    await fn({ vault, vaultPath, agentPath, agentId: AGENT_ID });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("canonical save writes strict scope and owner stains while the derived index omits stains", async () => {
  await withVault(async ({ vault, vaultPath, agentPath, agentId }) => {
    const saved = await vault.saveMemory(agentId, memoryInput({
      slug: "bubble-split-rule",
      description: "切分规则：按段落边界",
      stains: { agt_x1y2: "#7A8FA6" },
      content: "正文见 [[other-rule]]。",
    }));
    assert.match(saved.version, /^sha256:[0-9a-f]{64}$/);
    assert.equal(saved.sourceCount, 1);

    const full = await vault.getMemory(agentId, saved.slug);
    assert.deepEqual(full.scope, { type: "agent", agentId });
    assert.equal(full.sources[0].kind, "manual");
    assert.equal(full.sources[0].actor, "user");
    assert.deepEqual(full.stains, { agt_x1y2: "#7A8FA6" });

    const raw = await readFile(join(agentPath, `${saved.slug}.md`), "utf8");
    assert.match(raw, /^---\nschemaVersion: 1\nscope:\n  type: agent\n  agentId: agt_test01/);
    assert.match(raw, /sources:\n  - kind: manual\n    actor: user/);
    assert.match(raw, /createdAt: \d{4}-\d{2}-\d{2}T/);
    assert.match(raw, /\n\n正文见 \[\[other-rule\]\]。\n$/);

    const derivedIndex = await readFile(join(vaultPath, ".vera-index", `${agentId}.json`), "utf8");
    assert.doesNotMatch(derivedIndex, /stains|#7A8FA6/u);
  });
});

test("per-Agent queue makes concurrent creates of one slug one success and one conflict", async () => {
  await withVault(async ({ vault, agentPath, agentId }) => {
    const results = await Promise.allSettled([
      vault.saveMemory(agentId, memoryInput({ slug: "same-slug", content: "winner A" })),
      vault.saveMemory(agentId, memoryInput({ slug: "same-slug", content: "winner B" })),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "conflict");
    assert.equal(rejected.reason.details.reason, "slug_exists");
    assert.equal(rejected.reason.details.current.memory.slug, "same-slug");

    const full = await vault.getMemory(agentId, "same-slug");
    assert.ok(["winner A", "winner B"].includes(full.content));
    const raw = await readFile(join(agentPath, "same-slug.md"), "utf8");
    assert.match(raw, /^---\n/);
    assert.match(raw, /\n---\n\nwinner [AB]\n$/);
  });
});

test("same ifMatch concurrent updates produce one winner and one 409 current authority", async () => {
  await withVault(async ({ vault, agentId }) => {
    const created = await vault.saveMemory(agentId, memoryInput({ slug: "optimistic-update" }));
    const results = await Promise.allSettled([
      vault.updateMemory(agentId, created.slug, { ifMatch: created.version, content: "updated A" }),
      vault.updateMemory(agentId, created.slug, { ifMatch: created.version, content: "updated B" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "conflict");
    assert.equal(rejected.reason.details.reason, "version_mismatch");
    const current = rejected.reason.details.current.memory;
    assert.ok(["updated A", "updated B"].includes(current.content));
    assert.notEqual(current.version, created.version);
    assert.deepEqual(await vault.getMemory(agentId, created.slug), current);
  });
});

test("HTTP facades and MemoryOperation reject aliases, unknown fields, missing versions, and invalid frontmatter values", async () => {
  await withVault(async ({ vault, agentId }) => {
    const invalidCalls = [
      () => vault.saveMemory(agentId, memoryInput({ slug: "Not_Kebab" })),
      () => vault.saveMemory(agentId, memoryInput({ description: "two\nlines" })),
      () => vault.saveMemory(agentId, memoryInput({ stains: { "bad: key": "#AABBCC" } })),
      () => vault.saveMemory(agentId, { ...memoryInput(), sources: [{ kind: "manual", actor: "user", capturedAt: NOW }] }),
      () => vault.applyOperation({ ...operation({ kind: "create", slug: "alias-kind", value: memoryInput({ slug: undefined }) }), type: "create" }),
    ];
    for (const call of invalidCalls) await assert.rejects(call, (error) => error.code === "invalid_request");

    const created = await vault.saveMemory(agentId, memoryInput({ slug: "immutable-slug" }));
    await assert.rejects(
      () => vault.updateMemory(agentId, created.slug, { ifMatch: created.version, newSlug: "renamed" }),
      (error) => error.code === "invalid_request",
    );
    await assert.rejects(
      () => vault.updateMemory(agentId, created.slug, { content: "missing version" }),
      (error) => error.code === "invalid_request",
    );
    await assert.rejects(
      () => vault.deleteMemory(agentId, created.slug),
      (error) => error.code === "invalid_request",
    );
    assert.equal((await vault.getMemory(agentId, created.slug)).content, "authoritative body");
  });
});

test("exact kind-based MemoryOperation accepts message SourceRef and resolves it to the correct Space", async () => {
  const message = { id: "msg_source01", spaceId: "spc_alpha", content: "source fact" };
  const seen = [];
  await withVault(async ({ vault, agentId }) => {
    const created = await vault.applyOperation(operation({
      kind: "create",
      slug: "message-backed",
      value: {
        type: "decision",
        description: "comes from alpha",
        content: "remembered",
        sources: [{ kind: "message", spaceId: message.spaceId, messageId: message.id }],
      },
    }));
    assert.equal(created.sourceCount, 1);
    const full = await vault.getMemory(agentId, created.slug);
    assert.deepEqual(full.sources, [{ kind: "message", spaceId: "spc_alpha", messageId: "msg_source01" }]);
    assert.ok(seen.length >= 2, "create/index/get all resolve the source through the store callback");
    assert.ok(seen.every((source) => source.spaceId === message.spaceId && source.messageId === message.id));

    await assert.rejects(
      () => vault.applyOperation(operation({
        kind: "create",
        slug: "wrong-space",
        value: {
          type: "decision",
          description: "bad source",
          content: "bad",
          sources: [{ kind: "message", spaceId: "spc_beta", messageId: message.id }],
        },
      })),
      (error) => error.code === "invalid_request" && /does not belong/.test(error.message),
    );
  }, {
    resolveSource: async (source) => {
      seen.push(source);
      return source.messageId === message.id ? message : null;
    },
  });
});

test("legacy F1 frontmatter upgrades once to canonical scope and legacy manual source", async () => {
  await withVault(async ({ vault, agentPath, agentId }) => {
    await mkdir(agentPath, { recursive: true });
    const path = join(agentPath, "legacy-memory.md");
    await writeFile(path, [
      "---",
      "type: decision",
      "description: legacy hook",
      "status: active",
      "stains: {}",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "legacy body",
      "",
    ].join("\n"), "utf8");

    const migrated = await vault.getMemory(agentId, "legacy-memory");
    assert.deepEqual(migrated.scope, { type: "agent", agentId });
    assert.deepEqual(migrated.sources, [{ kind: "manual", actor: "legacy", capturedAt: "2026-01-01T00:00:00.000Z" }]);
    assert.equal(migrated.content, "legacy body");
    const canonical = await readFile(path, "utf8");
    assert.match(canonical, /schemaVersion: 1/);
    assert.match(canonical, /actor: legacy/);
    assert.match(canonical, /scope:\n  type: agent\n  agentId: agt_test01/);
  });
});

test("external Obsidian edits are found by rescan as create, update, and remove", async () => {
  await withVault(async ({ vault, agentPath, agentId }) => {
    const saved = await vault.saveMemory(agentId, memoryInput({ slug: "external-edit", description: "before edit" }));
    const path = join(agentPath, `${saved.slug}.md`);
    const beforeRaw = await readFile(path, "utf8");
    const afterRaw = beforeRaw
      .replace('description: "before edit"', 'description: "after edit"')
      .replace(/updatedAt: "[^"]+"/, 'updatedAt: "2026-12-31T00:00:00.000Z"');
    await writeFile(path, afterRaw, "utf8");

    const updated = await vault.listWithDiagnostics(agentId);
    assert.deepEqual(updated.updated, [saved.slug]);
    assert.equal(updated.memories.find((item) => item.slug === saved.slug).description, "after edit");

    await writeFile(join(agentPath, "external-added.md"), afterRaw, "utf8");
    const created = await vault.listWithDiagnostics(agentId);
    assert.deepEqual(created.created, ["external-added"]);
    assert.ok(created.memories.some((item) => item.slug === "external-added"));

    await unlink(path);
    const removed = await vault.listWithDiagnostics(agentId);
    assert.deepEqual(removed.removed, [saved.slug]);
    assert.ok(!removed.memories.some((item) => item.slug === saved.slug));
  });
});

test("bad files stay on disk, are excluded, and expose relative diagnostics plus 422 detail", async () => {
  await withVault(async ({ vault, agentPath, agentId }) => {
    await vault.saveMemory(agentId, memoryInput({ slug: "valid-memory" }));
    await writeFile(join(agentPath, "broken-memory.md"), "---\ntype: decision\nmissing end marker", "utf8");

    const result = await vault.listWithDiagnostics(agentId);
    assert.deepEqual(result.memories.map((item) => item.slug), ["valid-memory"]);
    assert.equal(result.invalid, 1);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "invalid_memory_file");
    assert.equal(result.errors[0].relativePath, `${agentId}/broken-memory.md`);
    assert.ok(!JSON.stringify(result.errors[0]).includes(agentPath), "diagnostics must not leak the absolute vault path");
    assert.equal(await readFile(join(agentPath, "broken-memory.md"), "utf8"), "---\ntype: decision\nmissing end marker");
    await assert.rejects(
      () => vault.getMemory(agentId, "broken-memory"),
      (error) => error.code === "invalid_memory_file" && error.details.file.relativePath === `${agentId}/broken-memory.md`,
    );
  });
});

test("missing and corrupt derived indexes rebuild to equivalent entries without changing markdown", async () => {
  await withVault(async ({ vault, vaultPath, agentPath, agentId }) => {
    await vault.saveMemory(agentId, memoryInput({ slug: "index-one", content: "links [[index-two]]" }));
    const second = await vault.saveMemory(agentId, memoryInput({ slug: "index-two", description: "second" }));
    await vault.updateMemory(agentId, second.slug, { ifMatch: second.version, status: "archived" });
    const baseline = await vault.listWithDiagnostics(agentId);
    const expected = baseline.memories;
    const markdownBefore = new Map(await Promise.all(expected.map(async ({ slug }) => [slug, await readFile(join(agentPath, `${slug}.md`), "utf8")])));
    const indexPath = join(vaultPath, ".vera-index", `${agentId}.json`);

    await unlink(indexPath);
    const missing = await vault.rebuildIndex(agentId);
    assert.deepEqual(missing.memories, expected);
    assert.equal(missing.index.status, "rebuilt");

    await writeFile(indexPath, "{ definitely not json", "utf8");
    const corrupt = await vault.rebuildIndex(agentId);
    assert.deepEqual(corrupt.memories, expected);
    assert.equal(corrupt.index.status, "rebuilt");

    await writeFile(indexPath, JSON.stringify({
      schemaVersion: 1,
      agentId,
      generation: 99,
      builtAt: NOW,
      fingerprints: [],
      entries: [null],
      errors: [],
    }), "utf8");
    const semanticCorrupt = await vault.rebuildIndex(agentId);
    assert.deepEqual(semanticCorrupt.memories, expected);
    assert.equal(semanticCorrupt.index.status, "rebuilt");
    for (const [slug, raw] of markdownBefore) assert.equal(await readFile(join(agentPath, `${slug}.md`), "utf8"), raw);
  });
});

test("Agent partitions isolate equal slugs and active listings exclude archived entries", async () => {
  await withVault(async ({ vault, agentId }) => {
    const secondAgent = "agt_test02";
    const first = await vault.saveMemory(agentId, memoryInput({ slug: "same-slug", content: "A" }));
    await vault.saveMemory(secondAgent, memoryInput({ slug: "same-slug", content: "B" }));
    await vault.updateMemory(agentId, first.slug, { ifMatch: first.version, status: "archived" });
    await vault.saveMemory(agentId, memoryInput({ slug: "active-one", description: "first active" }));
    await vault.saveMemory(agentId, memoryInput({ slug: "active-two", description: "second active" }));

    assert.equal((await vault.getMemory(secondAgent, "same-slug")).content, "B");
    const active = (await vault.listWithDiagnostics(agentId)).memories.filter((item) => item.status === "active");
    assert.deepEqual(active.map((item) => item.slug).sort(), ["active-one", "active-two"]);
  });
});

test("root markdown remains unscoped and absent agent directory lists cleanly", async () => {
  await withVault(async ({ vault, vaultPath, agentId }) => {
    await mkdir(vaultPath, { recursive: true });
    await writeFile(join(vaultPath, "legacy.md"), "legacy", "utf8");
    const result = await vault.listWithDiagnostics(agentId);
    assert.deepEqual(result.memories, []);
    assert.deepEqual(result.errors, []);
    const summary = await vault.inspect();
    assert.equal(summary.memoryCount, 0);
    assert.equal(summary.legacyUnscopedCount, 1);
  });
});

test("writes admitted during an exclusive vault migration use the reopened root", async () => {
  await withVault(async ({ vault, vaultPath, agentId }) => {
    const newRoot = join(vaultPath, "..", "migrated-vault");
    let releaseMigration;
    let markEntered;
    const entered = new Promise((resolve) => { markEntered = resolve; });
    const hold = new Promise((resolve) => { releaseMigration = resolve; });
    const migration = vault.withExclusive(async () => {
      markEntered();
      await hold;
      vault.reopen({ vaultPath: newRoot });
    });
    await entered;

    const delayedWrite = vault.saveMemory(agentId, memoryInput({ slug: "after-migration" }));
    releaseMigration();
    await migration;
    await delayedWrite;

    assert.match(await readFile(join(newRoot, agentId, "after-migration.md"), "utf8"), /authoritative body/);
    await assert.rejects(() => readFile(join(vaultPath, agentId, "after-migration.md"), "utf8"), { code: "ENOENT" });
  });
});

test("an interrupted replacement leaves the prior authoritative file complete", async () => {
  await withVault(async ({ vault, vaultPath, agentId }) => {
    const created = await vault.saveMemory(agentId, memoryInput({ slug: "atomic-old", content: "complete old body" }));
    const interrupted = createMemoryVault({
      vaultPath,
      writeMemoryFile: async (path, content) => {
        await writeFile(`${path}.interrupted`, content, "utf8");
        throw new Error("simulated interruption before atomic rename");
      },
    });

    await assert.rejects(
      () => interrupted.updateMemory(agentId, created.slug, { ifMatch: created.version, content: "complete new body" }),
      /simulated interruption/,
    );
    const authoritative = await vault.getMemory(agentId, created.slug);
    assert.equal(authoritative.content, "complete old body");
    assert.equal(authoritative.version, created.version);
  });
});
