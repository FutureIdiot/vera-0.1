import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStore } from "../../src/store/store.js";
import { createMemoryVault } from "../../src/memory/memory.js";
import {
  deleteArchivedSpace,
  getSpaceDeletionPreview,
} from "../../src/spaces/space-deletion.js";

const NOW = "2026-07-17T00:00:00.000Z";

async function fixture(run, { writeMemoryFile } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vera-space-delete-"));
  const store = await createStore({ dataPath: join(root, "data"), debounceMs: 5 });
  const memory = createMemoryVault({
    vaultPath: join(root, "memory"),
    resolveSource: ({ messageId }) => store.find("messages", messageId),
    writeMemoryFile,
  });
  store.insert("agents", { id: "agt_alpha", name: "Alpha", createdAt: NOW });
  store.insert("spaces", {
    id: "spc_delete",
    name: "Delete me",
    seats: [{ agentId: "agt_alpha", responseMode: "default" }],
    archivedAt: NOW,
    activeSpaceSessionId: "sps_delete",
    createdAt: NOW,
  });
  store.insert("spaceSessions", {
    id: "sps_delete",
    spaceId: "spc_delete",
    status: "active",
    createdAt: NOW,
    archivedAt: null,
    archiveReason: null,
  });
  store.insert("agentSessions", {
    id: "ags_delete",
    spaceSessionId: "sps_delete",
    agentId: "agt_alpha",
    generation: 1,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.insert("messages", {
    id: "msg_delete",
    spaceId: "spc_delete",
    spaceSessionId: "sps_delete",
    author: { type: "user" },
    target: { type: "broadcast" },
    content: "source",
    status: "completed",
    createdAt: NOW,
  });
  await memory.applyOperation({
    operationId: "mop_exclusive",
    agentId: "agt_alpha",
    origin: "memory-hook",
    kind: "create",
    slug: "exclusive-memory",
    value: {
      type: "project_rule",
      description: "Only this Space",
      content: "Exclusive",
      sources: [{ kind: "message", spaceId: "spc_delete", messageId: "msg_delete" }],
    },
    requestedAt: NOW,
  });
  await memory.applyOperation({
    operationId: "mop_mixed",
    agentId: "agt_alpha",
    origin: "memory-hook",
    kind: "create",
    slug: "mixed-memory",
    value: {
      type: "project_rule",
      description: "Mixed sources",
      content: "Mixed",
      sources: [
        { kind: "message", spaceId: "spc_delete", messageId: "msg_delete" },
        { kind: "manual", actor: "user", capturedAt: NOW },
      ],
    },
    requestedAt: NOW,
  });
  try {
    await run({ store, memory });
  } finally {
    await store.close();
  }
}

test("permanent Space deletion keeps Memory by default and tombstones deleted Message sources", async () => {
  await fixture(async ({ store, memory }) => {
    const preview = await getSpaceDeletionPreview({ store, memory, spaceId: "spc_delete" });
    assert.deepEqual(preview, {
      spaceId: "spc_delete",
      messageCount: 1,
      affectedMemoryCount: 2,
      exclusiveMemoryCount: 1,
    });

    const deleted = await deleteArchivedSpace({
      store,
      memory,
      spaceId: "spc_delete",
      deleteExclusiveMemories: false,
    });
    assert.equal(deleted.deletedMemoryCount, 0);
    assert.equal(store.find("spaces", "spc_delete"), null);
    assert.equal(store.find("messages", "msg_delete"), null);
    const exclusive = await memory.getMemory("agt_alpha", "exclusive-memory");
    assert.deepEqual(exclusive.sources, [{
      kind: "deleted-message",
      spaceId: "spc_delete",
      messageId: "msg_delete",
      deletedAt: exclusive.sources[0].deletedAt,
    }]);
    assert.equal(Number.isNaN(Date.parse(exclusive.sources[0].deletedAt)), false);
    const mixed = await memory.getMemory("agt_alpha", "mixed-memory");
    assert.equal(mixed.sources[0].kind, "deleted-message");
    assert.equal(mixed.sources[1].kind, "manual");
  });
});

test("checked deletion removes only Memory whose complete source set belongs to the Space", async () => {
  await fixture(async ({ store, memory }) => {
    const deleted = await deleteArchivedSpace({
      store,
      memory,
      spaceId: "spc_delete",
      deleteExclusiveMemories: true,
    });
    assert.equal(deleted.deletedMemoryCount, 1);
    await assert.rejects(
      () => memory.getMemory("agt_alpha", "exclusive-memory"),
      (error) => error.code === "not_found",
    );
    const mixed = await memory.getMemory("agt_alpha", "mixed-memory");
    assert.equal(mixed.sources[0].kind, "deleted-message");
    assert.equal(mixed.sources[1].kind, "manual");
  });
});

test("Memory writes admitted during deletion cannot create a dangling Message source", async () => {
  let releaseTombstone;
  let tombstoneWriteStarted;
  const tombstoneGate = new Promise((resolve) => { releaseTombstone = resolve; });
  const tombstoneStarted = new Promise((resolve) => { tombstoneWriteStarted = resolve; });
  const writeMemoryFile = async (path, content) => {
    if (content.includes("kind: deleted-message")) {
      tombstoneWriteStarted();
      await tombstoneGate;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  };
  await fixture(async ({ store, memory }) => {
    const deletion = deleteArchivedSpace({
      store,
      memory,
      spaceId: "spc_delete",
      deleteExclusiveMemories: false,
    });
    await tombstoneStarted;
    const lateWrite = memory.applyOperation({
      operationId: "mop_late",
      agentId: "agt_alpha",
      origin: "memory-hook",
      kind: "create",
      slug: "late-memory",
      value: {
        type: "project_rule",
        description: "Late source",
        content: "Late",
        sources: [{ kind: "message", spaceId: "spc_delete", messageId: "msg_delete" }],
      },
      requestedAt: NOW,
    });
    releaseTombstone();
    await deletion;
    await assert.rejects(
      lateWrite,
      (error) => error.code === "invalid_request" && /does not exist/u.test(error.message),
    );
  }, { writeMemoryFile });
});
