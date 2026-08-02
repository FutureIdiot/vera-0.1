import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExtensionLoader, permissionModelFlag } from "../../src/extensions/loader.js";

function storeFixture() {
  const data = new Map();
  return {
    list(name) { return [...(data.get(name) ?? new Map()).values()]; },
    find(name, id) { return data.get(name)?.get(id) ?? null; },
    insert(name, value) { if (!data.has(name)) data.set(name, new Map()); const next = { ...value }; data.get(name).set(next.id, next); return next; },
    update(name, id, patch) { const next = { ...data.get(name).get(id), ...patch }; data.get(name).set(id, next); return next; },
    remove(name, id) { data.get(name)?.delete(id); },
  };
}

async function extensionFixture() {
  const root = await mkdtemp(join(tmpdir(), "vera-extension-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, extensionId: "example.test", name: "Example", version: "1.0.0", entry: "src/index.js", capabilities: [{ unitId: "example.test.mcp", kind: "mcp", name: "Example MCP" }, { unitId: "example.test.hook", kind: "hook", name: "Example Hook" }] }));
  await writeFile(join(root, "src/index.js"), "export function getManifest(){return {schemaVersion:1,extensionId:'example.test',name:'Example',version:'1.0.0',entry:'src/index.js',capabilities:[{unitId:'example.test.mcp',kind:'mcp',name:'Example MCP'},{unitId:'example.test.hook',kind:'hook',name:'Example Hook'}]}}; export async function initialize(){return {mcp:{call:async({name})=>({name})},hooks:{hook:{handle:async({event})=>({echo:event.value})}},shutdown(){}}}");
  return root;
}

test("selects the permission-model flag supported by the Node runtime", () => {
  assert.equal(permissionModelFlag(new Set(["--permission", "--experimental-permission"])), "--permission");
  assert.equal(permissionModelFlag(new Set(["--experimental-permission"])), "--experimental-permission");
  assert.equal(permissionModelFlag(new Set()), null);
});

test("registers, binds, initializes and unloads an external extension", async () => {
  const store = storeFixture();
  store.insert("agents", { id: "agt_test" });
  const loader = createExtensionLoader({ store });
  const sourcePath = await extensionFixture();
  const extension = await loader.register(sourcePath);
  assert.equal(extension.extensionId, "example.test");
  const binding = await loader.bindAgent("example.test", "agt_test", { enabled: true });
  assert.equal(binding.instance.status, "initialized");
  assert.deepEqual(await loader.callMcp("example.test", "agt_test", { name: "echo" }), { name: "echo" });
  assert.deepEqual(await loader.callHook("example.test", "agt_test", { unitId: "example.test.hook", event: { value: "ok" } }), { echo: "ok" });
  assert.equal((await loader.listAgent("agt_test"))[0].binding.enabled, true);
  await loader.close();
  assert.equal(store.list("extensionBindings")[0].enabled, true);
  await loader.unload("example.test");
  assert.equal(loader.get("example.test").status, "registered");
  await loader.close();
});

test("rejects an entry that escapes the extension directory", async () => {
  const store = storeFixture();
  const loader = createExtensionLoader({ store });
  const root = await mkdtemp(join(tmpdir(), "vera-extension-bad-"));
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, extensionId: "bad.test", name: "Bad", version: "1.0.0", entry: "../bad.js", capabilities: [{ unitId: "bad.test.mcp", kind: "mcp", name: "Bad" }] }));
  await assert.rejects(() => loader.register(root), { code: "invalid_request" });
});
