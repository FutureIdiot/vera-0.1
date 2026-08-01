import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";
import { manifestCapabilities, validateManifest } from "./manifest.js";
import { validateExtensionDirectory, validateExtensionEntry } from "./path-policy.js";

function version() { return `exv_${randomUUID().replaceAll("-", "")}`; }
function invalid(message) { throw new ApiError("invalid_request", message); }
function extensionId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9.-]{1,80}$/.test(value)) invalid("invalid extension id");
  return value;
}

export function createExtensionLoader({ store, config = {}, onUpdated = null } = {}) {
  if (!store) throw new TypeError("extension loader requires store");
  const instances = new Map();
  const workers = new Map();
  const registered = new Map();
  const workerRequestTimeoutMs = Math.max(1000, Number(config.extensions?.workerRequestTimeoutMs) || 30000);

  function find(id) { return registered.get(id) ?? store.find("extensions", id) ?? null; }
  function publicRecord(record) {
    if (!record) return null;
    return {
      extensionId: record.extensionId,
      name: record.name,
      version: record.version,
      sourcePath: record.sourcePath,
      status: record.status,
      errorCode: record.errorCode ?? null,
      capabilities: record.capabilities ?? [],
      bindingVersion: record.bindingVersion ?? null,
      updatedAt: record.updatedAt,
    };
  }
  function save(record) {
    const existing = store.find("extensions", record.extensionId);
    const next = existing ? store.update("extensions", existing.id, record) : store.insert("extensions", { id: record.extensionId, ...record });
    registered.set(record.extensionId, next);
    try { onUpdated?.(publicRecord(next)); } catch {}
    return next;
  }
  async function readManifest(root) {
    let raw;
    try { raw = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")); }
    catch { throw new ApiError("invalid_request", "extension manifest.json cannot be read"); }
    return validateManifest(raw, { rootPath: root });
  }
  async function assertDirectory(sourcePath) { return (await validateExtensionDirectory(sourcePath)).rootPath; }
  async function register(sourcePath) {
    const root = await assertDirectory(sourcePath);
    const manifest = await readManifest(root);
    const now = new Date().toISOString();
    return publicRecord(save({
      extensionId: manifest.extensionId,
      name: manifest.name,
      version: manifest.version,
      sourcePath: root,
      manifest,
      capabilities: manifestCapabilities(manifest),
      status: "registered",
      errorCode: null,
      bindingVersion: version(),
      updatedAt: now,
    }));
  }
  function list() {
    for (const record of store.list("extensions")) registered.set(record.extensionId, record);
    return [...registered.values()].map(publicRecord).sort((a, b) => a.extensionId.localeCompare(b.extensionId));
  }

  function spawnWorker(key, root, { writePaths = [] } = {}) {
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    if (!process.allowedNodeEnvironmentFlags?.has("--permission")) {
      throw new ApiError("extension_load_failed", "external extensions require a Node runtime with the permission model");
    }
    const execArgv = ["--permission", `--allow-fs-read=${root}`, `--allow-fs-read=${workerPath}`, ...writePaths.filter((path) => typeof path === "string" && path.startsWith("/")).flatMap((path) => [`--allow-fs-read=${path}`, `--allow-fs-write=${path}`])];
    const child = fork(workerPath, [], { cwd: root, silent: true, execArgv, env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" } });
    let sequence = 0;
    const pending = new Map();
    const fail = (error) => {
      for (const callback of pending.values()) {
        clearTimeout(callback.timer);
        callback.reject(error);
      }
      pending.clear();
      workers.delete(key);
    };
    child.on("message", (message) => {
      const callback = pending.get(message.id);
      if (!callback) return;
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.ok) callback.resolve(message.value);
      else callback.reject(Object.assign(new Error(message.error?.message ?? "extension worker failed"), { code: message.error?.code ?? "extension_load_failed", stack: message.error?.stack }));
    });
    child.on("error", fail);
    child.on("exit", () => { if (pending.size) fail(Object.assign(new Error("extension worker exited"), { code: "extension_load_failed" })); });
    const worker = {
      child,
      request(action, payload = {}) {
        return new Promise((resolve, reject) => {
          const id = `req_${++sequence}`;
          const timer = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            reject(Object.assign(new Error("extension worker request timed out"), { code: "extension_timeout" }));
            child.kill();
          }, workerRequestTimeoutMs);
          pending.set(id, { resolve, reject, timer });
          child.send({ id, action, ...payload }, (error) => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
        });
      },
    };
    workers.set(key, worker);
    return worker;
  }

  async function ensureWorker(record, agentKey, options = {}) {
    const key = `${record.extensionId}:${agentKey}`;
    const existing = workers.get(key);
    if (existing) return existing;
    const root = await assertDirectory(record.sourcePath);
    const manifest = await readManifest(root);
    if (record.manifest && (record.manifest.extensionId !== manifest.extensionId || record.manifest.version !== manifest.version)) {
      throw new ApiError("extension_manifest_changed", "extension manifest changed; register the directory again before loading");
    }
    const entryPath = await validateExtensionEntry(root, manifest.entry);
    const worker = spawnWorker(key, root, options);
    try {
      const result = await worker.request("load", { entryUrl: `${pathToFileURL(entryPath).href}?veraExtensionVersion=${encodeURIComponent(manifest.version)}` });
      const runtimeManifest = validateManifest(result.manifest, { rootPath: root });
      if (runtimeManifest.extensionId !== manifest.extensionId || runtimeManifest.version !== manifest.version) {
        throw new ApiError("extension_manifest_changed", "runtime manifest does not match registered manifest");
      }
      return worker;
    } catch (error) {
      worker.child.kill();
      workers.delete(key);
      throw error?.code ? error : new ApiError("extension_load_failed", "extension failed to load");
    }
  }

  async function load(id, { ifMatch = null } = {}) {
    const record = find(extensionId(id));
    if (!record) throw new ApiError("not_found", `extension ${id} does not exist`);
    if (ifMatch !== null && record.bindingVersion !== ifMatch) throw new ApiError("conflict", "extension version does not match");
    try {
      await ensureWorker(record, "__manifest");
      return publicRecord(save({ ...record, status: "loaded", errorCode: null, bindingVersion: version(), updatedAt: new Date().toISOString() }));
    } catch (error) {
      save({ ...record, status: "failed", errorCode: error.code ?? "extension_load_failed", updatedAt: new Date().toISOString() });
      throw error;
    }
  }

  async function initializeForAgent(id, agentId) {
    const record = find(extensionId(id));
    if (!record) throw new ApiError("not_found", `extension ${id} does not exist`);
    if (record.status !== "loaded") await load(id);
    const extensionConfig = { ...(config.extensions?.[id] ?? {}) };
    if (extensionConfig.vaultPath === undefined && config.memory?.vaultPath) extensionConfig.vaultPath = config.memory.vaultPath;
    const agentVaultPath = extensionConfig.vaultPath ? join(extensionConfig.vaultPath, agentId) : null;
    if (agentVaultPath) await mkdir(agentVaultPath, { recursive: true, mode: 0o700 });
    const worker = await ensureWorker(record, agentId, { writePaths: agentVaultPath ? [agentVaultPath] : [] });
    const result = await worker.request("initialize", { extensionId: id, version: record.version, agentId, config: extensionConfig });
    const publicInstance = { extensionId: id, agentId, ...result.instance };
    instances.set(`${agentId}:${id}`, { worker, public: publicInstance });
    return publicInstance;
  }

  async function bindAgent(id, agentId, { enabled = true, ifMatch = null } = {}) {
    if (!store.find("agents", agentId)) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    const record = find(extensionId(id));
    if (!record) throw new ApiError("not_found", `extension ${id} does not exist`);
    const current = store.list("extensionBindings").find((item) => item.agentId === agentId && item.extensionId === id) ?? null;
    if (current && ifMatch !== current.version) throw new ApiError("conflict", "extension binding version does not match", { reason: "version_mismatch", current: { version: current.version } });
    if (!current && ifMatch !== null) throw new ApiError("conflict", "extension binding does not exist");
    const saved = current
      ? store.update("extensionBindings", current.id, { enabled: Boolean(enabled), version: version(), updatedAt: new Date().toISOString(), errorCode: null })
      : store.insert("extensionBindings", { id: `${agentId}:${id}`, agentId, extensionId: id, enabled: Boolean(enabled), version: version(), updatedAt: new Date().toISOString(), errorCode: null });
    if (enabled) {
      try { await initializeForAgent(id, agentId); }
      catch (error) {
        store.update("extensionBindings", saved.id, { enabled: false, version: version(), errorCode: error.code ?? "extension_load_failed", updatedAt: new Date().toISOString() });
        throw error;
      }
    } else await unbindAgent(id, agentId, { ifMatch: saved.version, remove: false });
    const latest = store.find("extensionBindings", saved.id);
    return { ...latest, extension: publicRecord(find(id)), instance: instances.get(`${agentId}:${id}`)?.public ?? null };
  }

  async function unbindAgent(id, agentId, { ifMatch = null, remove = true } = {}) {
    const current = store.list("extensionBindings").find((item) => item.agentId === agentId && item.extensionId === id) ?? null;
    if (!current) return null;
    if (ifMatch === null || current.version !== ifMatch) throw new ApiError("conflict", "extension binding version does not match");
    const key = `${agentId}:${id}`;
    const active = instances.get(key);
    if (active) { await active.worker.request("shutdown").catch(() => {}); instances.delete(key); }
    if (remove) store.remove("extensionBindings", current.id);
    else store.update("extensionBindings", current.id, { enabled: false, version: version(), updatedAt: new Date().toISOString() });
    return { agentId, extensionId: id, enabled: false, version: store.find("extensionBindings", current.id)?.version ?? null };
  }

  async function listAgent(agentId) {
    if (!store.find("agents", agentId)) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    const bindings = store.list("extensionBindings").filter((item) => item.agentId === agentId);
    const byId = new Map(bindings.map((item) => [item.extensionId, item]));
    return list().map((extension) => ({ extension, binding: byId.get(extension.extensionId) ? { enabled: byId.get(extension.extensionId).enabled, version: byId.get(extension.extensionId).version, errorCode: byId.get(extension.extensionId).errorCode ?? null } : null, instance: instances.get(`${agentId}:${extension.extensionId}`)?.public ?? null }));
  }

  async function callMcp(id, agentId, { name, arguments: args = {} } = {}) {
    const binding = store.list("extensionBindings").find((item) => item.agentId === agentId && item.extensionId === id && item.enabled);
    if (!binding) throw new ApiError("forbidden", "extension is not enabled for this Agent");
    const active = instances.get(`${agentId}:${id}`);
    if (!active) throw new ApiError("extension_load_failed", "extension is not initialized for this Agent");
    return (await active.worker.request("mcpCall", { agentId, name, arguments: args })).result;
  }

  function getAgentCapability(agentId, capability) {
    for (const extension of list()) {
      if (!extension.capabilities.some((item) => item.capability === capability)) continue;
      const binding = store.list("extensionBindings").find((item) => item.agentId === agentId && item.extensionId === extension.extensionId);
      if (binding?.enabled) {
        return { extension, binding, instance: instances.get(`${agentId}:${extension.extensionId}`)?.public ?? null };
      }
    }
    return null;
  }

  async function callHook(id, agentId, { unitId, event = {} } = {}) {
    const binding = store.list("extensionBindings").find((item) => item.agentId === agentId && item.extensionId === id && item.enabled);
    if (!binding) throw new ApiError("forbidden", "extension is not enabled for this Agent");
    const active = instances.get(`${agentId}:${id}`);
    if (!active) throw new ApiError("extension_load_failed", "extension is not initialized for this Agent");
    return (await active.worker.request("hookCall", { agentId, unitId, event })).result;
  }

  async function unload(id, { ifMatch = null } = {}) {
    extensionId(id);
    const record = find(id);
    if (!record) throw new ApiError("not_found", `extension ${id} does not exist`);
    if (ifMatch !== null && record.bindingVersion !== ifMatch) throw new ApiError("conflict", "extension version does not match");
    for (const [key, worker] of workers) {
      if (!key.startsWith(`${id}:`)) continue;
      await worker.request("shutdown").catch(() => {});
      worker.child.kill();
      workers.delete(key);
    }
    for (const [key] of instances) if (key.endsWith(`:${id}`)) instances.delete(key);
    for (const binding of store.list("extensionBindings").filter((item) => item.extensionId === id)) {
      store.update("extensionBindings", binding.id, { enabled: false, version: version(), updatedAt: new Date().toISOString() });
    }
    save({ ...record, status: "registered", errorCode: null, bindingVersion: version(), updatedAt: new Date().toISOString() });
  }

  async function initializeExistingBindings() {
    const failures = [];
    for (const binding of store.list("extensionBindings")) {
      if (!binding.enabled) continue;
      try { await initializeForAgent(binding.extensionId, binding.agentId); }
      catch (error) {
        failures.push({ extensionId: binding.extensionId, agentId: binding.agentId, code: error.code ?? "extension_load_failed" });
        store.update("extensionBindings", binding.id, { enabled: false, version: version(), errorCode: error.code ?? "extension_load_failed", updatedAt: new Date().toISOString() });
      }
    }
    return failures;
  }
  async function close() {
    for (const [key, worker] of workers) {
      await worker.request("shutdown").catch(() => {});
      worker.child.kill();
      workers.delete(key);
    }
    instances.clear();
  }
  return { register, list, get: (id) => publicRecord(find(extensionId(id))), load, unload, bindAgent, unbindAgent, listAgent, callMcp, callHook, getAgentCapability, initializeExistingBindings, close };
}
