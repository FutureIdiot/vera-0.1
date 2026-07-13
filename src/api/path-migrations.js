import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ApiError } from "../core/errors.js";
import { validateStoreDirectory } from "../store/validate-store.js";

const AGENT_ID_PATTERN = /^agt_[a-z0-9]+$/;

async function movePath(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true, errorOnExist: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function countFiles(path) {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(path, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

async function restoreSetting(settingsStore, key, previous) {
  await settingsStore.setAll({ [key]: previous ?? null });
  await settingsStore.flush();
}

async function writeAnchorOverride({ bootPaths, currentDataPath, key, value }) {
  const anchor = bootPaths?.anchorDataPath;
  if (!anchor || resolve(anchor) === resolve(currentDataPath)) return null;
  const path = join(anchor, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};
  const hadPrevious = Object.prototype.hasOwnProperty.call(settings, key);
  const previous = settings[key];
  settings[key] = value;
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), "utf8");
  await rename(temporary, path);
  return { path, key, hadPrevious, previous };
}

async function restoreAnchorOverride(snapshot) {
  if (!snapshot) return;
  const settings = JSON.parse(await readFile(snapshot.path, "utf8"));
  if (snapshot.hadPrevious) settings[snapshot.key] = snapshot.previous;
  else delete settings[snapshot.key];
  const temporary = `${snapshot.path}.tmp`;
  await writeFile(temporary, JSON.stringify(settings, null, 2), "utf8");
  await rename(temporary, snapshot.path);
}

async function migrateVaultPathExclusive({ config, settingsStore, memory, bootPaths, target }) {
  const from = memory.getVaultPath();
  if (from === target) return { ok: true, key: "memory.vaultPath", from, to: target, restartRequired: false };
  const summary = await memory.inspect();
  if (summary.legacyUnscopedCount > 0) {
    throw new ApiError("conflict", `vault contains ${summary.legacyUnscopedCount} unscoped legacy markdown file(s)`);
  }

  await mkdir(from, { recursive: true });
  await mkdir(target, { recursive: true });
  const sourceEntries = await readdir(from, { withFileTypes: true });
  const agentDirs = sourceEntries.filter((entry) => entry.isDirectory() && AGENT_ID_PATTERN.test(entry.name));
  const moved = [];
  const expected = new Map();
  const previousOverride = settingsStore.get("paths.memoryVaultPath");
  let anchorSnapshot = null;
  try {
    const targetEntries = new Set((await readdir(target)).filter((name) => AGENT_ID_PATTERN.test(name)));
    const collision = agentDirs.find((entry) => targetEntries.has(entry.name));
    if (collision) throw new ApiError("conflict", `target already contains agent directory ${collision.name}`);
    for (const entry of agentDirs) {
      const src = join(from, entry.name);
      const dst = join(target, entry.name);
      expected.set(entry.name, await countFiles(src));
      await movePath(src, dst);
      moved.push({ src, dst });
    }
    for (const [name, expectedCount] of expected) {
      const actualCount = await countFiles(join(target, name));
      if (actualCount !== expectedCount) throw new Error(`verification failed for ${name}: expected ${expectedCount}, found ${actualCount}`);
    }
    await settingsStore.setAll({ "paths.memoryVaultPath": target });
    await settingsStore.flush();
    anchorSnapshot = await writeAnchorOverride({
      bootPaths, currentDataPath: config.dataPath, key: "paths.memoryVaultPath", value: target,
    });
    memory.reopen({ vaultPath: target });
    return { ok: true, key: "memory.vaultPath", from, to: target, restartRequired: false };
  } catch (err) {
    try { await restoreSetting(settingsStore, "paths.memoryVaultPath", previousOverride); } catch { /* preserve original error */ }
    try { await restoreAnchorOverride(anchorSnapshot); } catch { /* preserve original error */ }
    for (const item of moved.reverse()) {
      try { await movePath(item.dst, item.src); } catch { /* best effort; original remains loud */ }
    }
    if (err instanceof ApiError) throw err;
    throw new ApiError("internal", `memory vault migration failed and was rolled back: ${err.message}`);
  }
}

export async function migrateVaultPath(dependencies) {
  return dependencies.memory.withExclusive(() => migrateVaultPathExclusive(dependencies));
}

async function backupExistingTarget(target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(target);
  if (entries.length === 0) return null;
  const backup = await mkdtemp(join(dirname(target), ".vera-data-migrate-"));
  for (const name of entries) await rename(join(target, name), join(backup, name));
  return backup;
}

async function restoreTarget(target, backup) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  if (!backup) return;
  for (const name of await readdir(backup)) await rename(join(backup, name), join(target, name));
  await rm(backup, { recursive: true, force: true });
}

export async function migrateDataPath({ config, settingsStore, store, bootPaths, target }) {
  const from = config.dataPath;
  if (from === target) return { ok: true, key: "gateway.dataPath", from, to: target, restartRequired: false };
  const previousOverride = settingsStore.get("paths.gateway.dataPath");
  let backup = null;
  let anchorSnapshot = null;
  try {
    await store.flush();
    await settingsStore.flush();
    backup = await backupExistingTarget(target);
    for (const entry of await readdir(from, { withFileTypes: true })) {
      await cp(join(from, entry.name), join(target, entry.name), { recursive: entry.isDirectory(), errorOnExist: true });
    }
    await validateStoreDirectory(target);
    await settingsStore.setAll({ "paths.gateway.dataPath": target });
    await settingsStore.flush();
    anchorSnapshot = await writeAnchorOverride({
      bootPaths, currentDataPath: config.dataPath, key: "paths.gateway.dataPath", value: target,
    });
    if (backup) await rm(backup, { recursive: true, force: true });
    return { ok: true, key: "gateway.dataPath", from, to: target, restartRequired: true };
  } catch (err) {
    try { await restoreSetting(settingsStore, "paths.gateway.dataPath", previousOverride); } catch { /* preserve original error */ }
    try { await restoreAnchorOverride(anchorSnapshot); } catch { /* preserve original error */ }
    try { await restoreTarget(target, backup); } catch { /* preserve original error */ }
    if (err instanceof ApiError) throw err;
    throw new ApiError("internal", `gateway data migration failed and was rolled back: ${err.message}`);
  }
}
