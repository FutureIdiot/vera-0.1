// P5-F1 Files black-box matrix: binary integrity, isolation/share/global reads,
// Message references, tombstones, validation errors, and hot path migration.

import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBinaryHttpClient, createHttpClient, startGateway } from "./_helpers.mjs";

async function createSpace(httpRequest, agentId, name) {
  const response = await httpRequest("POST", "/api/spaces", { name, seats: [{ agentId }] });
  if (response.status !== 201) throw new Error(`failed to create ${name}`);
  return response.json.space;
}

async function upload(binaryRequest, spaceId, name, mime, body, portOverride) {
  return binaryRequest("POST", `/api/spaces/${spaceId}/files`, {
    headers: {
      "Content-Type": mime,
      "X-Vera-File-Name": encodeURIComponent(name),
    },
    body,
    portOverride,
  });
}

export async function run(ctx) {
  const { check, httpRequest, binaryRequest, assertEqual, assert, agent, sse, dataDir } = ctx;
  let owner;
  let shared;
  let third;
  let firstFile;
  const bytes = Buffer.from([0, 1, 2, 10, 13, 255, 42]);

  await check("p5-f1.1 raw upload is atomic, binary-safe, and same names do not overwrite", async () => {
    owner = await createSpace(httpRequest, agent.id, "Files owner");
    shared = await createSpace(httpRequest, agent.id, "Files shared");
    third = await createSpace(httpRequest, agent.id, "Files global");
    const createdEventPromise = sse.waitFor((event) =>
      event.type === "file.created" && event.data?.spaceId === owner.id);
    const first = await upload(binaryRequest, owner.id, "same-name.txt", "text/plain", bytes);
    assertEqual(first.status, 201);
    firstFile = first.json.file;
    assertEqual(firstFile.name, "same-name.txt");
    assertEqual("storageName" in firstFile, false);
    assertEqual(JSON.stringify(firstFile).includes(dataDir), false);
    const createdEvent = await createdEventPromise;
    assertEqual(createdEvent.data.file.id, firstFile.id);
    assertEqual("sha256" in createdEvent.data.file, false);
    const second = await upload(binaryRequest, owner.id, "same-name.txt", "text/plain", Buffer.from("second"));
    assertEqual(second.status, 201);
    assert(second.json.file.id !== firstFile.id, "same display names must create distinct File ids");
    const list = await httpRequest("GET", `/api/spaces/${owner.id}/files`);
    assertEqual(list.status, 200);
    assertEqual(list.json.files.filter((file) => file.name === "same-name.txt").length, 2);
    const download = await binaryRequest("GET", `/api/spaces/${owner.id}/files/${firstFile.id}/download`);
    assertEqual(download.status, 200);
    assertEqual(Buffer.compare(download.buffer, bytes), 0);
  });

  await check("p5-f1.2 isolated, specifiedShared, and globalReadable policies are real consumers", async () => {
    assertEqual((await httpRequest("GET", `/api/spaces/${shared.id}/files`)).json.files.length, 0);
    assertEqual((await httpRequest("GET", `/api/spaces/${shared.id}/files/${firstFile.id}`)).status, 404);
    await httpRequest("PATCH", "/api/settings", { settings: { "isolation.files": "specifiedShared" } });
    const updated = await httpRequest("PATCH", `/api/spaces/${owner.id}/files/${firstFile.id}`, {
      sharedSpaceIds: [shared.id],
      ifMatch: firstFile.version,
    });
    assertEqual(updated.status, 200);
    firstFile = updated.json.file;
    const sharedList = await httpRequest("GET", `/api/spaces/${shared.id}/files`);
    assertEqual(sharedList.json.files.some((file) => file.id === firstFile.id), true);
    assertEqual(sharedList.json.files.find((file) => file.id === firstFile.id).canManage, false);
    assertEqual((await httpRequest("GET", `/api/spaces/${third.id}/files`)).json.files.some((file) => file.id === firstFile.id), false);
    const stale = await httpRequest("PATCH", `/api/spaces/${owner.id}/files/${firstFile.id}`, {
      sharedSpaceIds: [],
      ifMatch: firstFile.version - 1,
    });
    assertEqual(stale.status, 409);
    await httpRequest("PATCH", "/api/settings", { settings: { "isolation.files": "globalReadable" } });
    assertEqual((await httpRequest("GET", `/api/spaces/${third.id}/files`)).json.files.some((file) => file.id === firstFile.id), true);
  });

  await check("p5-f1.3 Message fileIds project into timeline and deletion leaves a safe tombstone", async () => {
    const sent = await httpRequest("POST", `/api/spaces/${third.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "",
      fileIds: [firstFile.id],
    });
    assertEqual(sent.status, 201);
    assertEqual(sent.json.message.fileIds[0], firstFile.id);
    const before = await httpRequest("GET", `/api/spaces/${third.id}/timeline?limit=50`);
    const message = before.json.items.find((item) => item.id === sent.json.message.id);
    assertEqual(message.attachments[0].state, "available");
    assertEqual(message.attachments[0].name, firstFile.name);
    const deletedEventPromise = sse.waitFor((event) =>
      event.type === "file.deleted" && event.data?.fileId === firstFile.id);
    const deleted = await httpRequest("DELETE", `/api/spaces/${owner.id}/files/${firstFile.id}?ifMatch=${firstFile.version}`);
    assertEqual(deleted.status, 204);
    await deletedEventPromise;
    const after = await httpRequest("GET", `/api/spaces/${third.id}/timeline?limit=50`);
    assertEqual(after.json.items.find((item) => item.id === sent.json.message.id).attachments[0].state, "deleted");
    assertEqual((await binaryRequest("GET", `/api/spaces/${owner.id}/files/${firstFile.id}/download`)).status, 404);
  });

  await check("p5-f1.4 traversal and MIME mismatches are rejected without visible records", async () => {
    const before = (await httpRequest("GET", `/api/spaces/${owner.id}/files`)).json.files.length;
    const traversal = await upload(binaryRequest, owner.id, "../secret.txt", "text/plain", Buffer.from("x"));
    assertEqual(traversal.status, 400);
    const mismatch = await upload(binaryRequest, owner.id, "image.png", "text/plain", Buffer.from("x"));
    assertEqual(mismatch.status, 415);
    const after = (await httpRequest("GET", `/api/spaces/${owner.id}/files`)).json.files.length;
    assertEqual(after, before);
  });

  await check("p5-f1.5 Files root migration verifies content and hot-switches downloads", async () => {
    const uploaded = await upload(binaryRequest, owner.id, "migrate.pdf", "application/pdf", Buffer.from("%PDF-test"));
    assertEqual(uploaded.status, 201);
    const target = join(dataDir, "migrated-files");
    const migrated = await httpRequest("POST", "/api/paths/migrate", { key: "files.attachmentsPath", target });
    assertEqual(migrated.status, 200);
    assertEqual(migrated.json.restartRequired, false);
    const paths = await httpRequest("GET", "/api/paths");
    assertEqual(paths.json.paths.files.attachmentsPath, target);
    const downloaded = await binaryRequest("GET", `/api/spaces/${owner.id}/files/${uploaded.json.file.id}/download`);
    assertEqual(downloaded.buffer.toString("utf8"), "%PDF-test");
  });

  await check("p5-f1.6 configured upload limit returns 413 and leaves no File", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-files-limit-"));
    let gateway;
    try {
      gateway = await startGateway({
        repoRoot: ctx.repoRoot,
        env: {
          VERA_DATA_PATH: join(root, "data"),
          VERA_MEMORY_VAULT_PATH: join(root, "memory"),
          VERA_FILES_ATTACHMENTS_PATH: join(root, "files"),
          VERA_FILES_MAX_UPLOAD_BYTES: "8",
        },
      });
      const http = createHttpClient(gateway.port);
      const binary = createBinaryHttpClient(gateway.port);
      const createdAgent = await http("POST", "/api/agents", { name: "Files limit", provider: "mock" });
      const space = await createSpace(http, createdAgent.json.agent.id, "Files limit");
      const tooLarge = await upload(binary, space.id, "large.txt", "text/plain", Buffer.from("123456789"));
      assertEqual(tooLarge.status, 413);
      assertEqual((await http("GET", `/api/spaces/${space.id}/files`)).json.files.length, 0);
    } finally {
      await gateway?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  await check("p5-f1.7 permanent owner Space deletion tombstones every shared File", async () => {
    await httpRequest("PATCH", "/api/settings", { settings: { "isolation.files": "specifiedShared" } });
    const uploaded = await upload(binaryRequest, owner.id, "cascade.txt", "text/plain", Buffer.from("cascade"));
    assertEqual(uploaded.status, 201);
    const sharedFile = await httpRequest("PATCH", `/api/spaces/${owner.id}/files/${uploaded.json.file.id}`, {
      sharedSpaceIds: [shared.id],
      ifMatch: uploaded.json.file.version,
    });
    assertEqual(sharedFile.status, 200);
    const sent = await httpRequest("POST", `/api/spaces/${shared.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "shared owner deletion",
      fileIds: [sharedFile.json.file.id],
    });
    assertEqual(sent.status, 201);
    await httpRequest("POST", `/api/spaces/${owner.id}/archive`);
    const deletedEvent = sse.waitFor((event) =>
      event.type === "file.deleted" && event.data?.fileId === sharedFile.json.file.id);
    const removed = await httpRequest("DELETE", `/api/spaces/${owner.id}`, {
      deleteExclusiveMemories: false,
    });
    assertEqual(removed.status, 200);
    await deletedEvent;
    const timeline = await httpRequest("GET", `/api/spaces/${shared.id}/timeline?limit=50`);
    const message = timeline.json.items.find((item) => item.id === sent.json.message.id);
    assertEqual(message.attachments[0].state, "deleted");
    assertEqual(
      (await binaryRequest("GET", `/api/spaces/${shared.id}/files/${sharedFile.json.file.id}/download`)).status,
      404,
    );
  });
}
