// Boot-time path override discovery. settings.json lives inside dataPath, so
// server startup must inspect the env/default anchor before constructing the
// real store and settingsStore (api-contract.md "gateway.dataPath 启动顺序").

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function readSettings(dataPath) {
  try {
    const parsed = JSON.parse(await readFile(join(dataPath, "settings.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return {};
    throw err;
  }
}

export async function applyBootPathOverrides(config) {
  const anchorDataPath = resolve(config.dataPath);
  const settings = await readSettings(anchorDataPath);
  const dataOverride = settings["paths.gateway.dataPath"];
  const vaultOverride = settings["paths.memoryVaultPath"];
  const filesOverride = settings["paths.filesAttachmentsPath"];

  if (typeof dataOverride === "string" && dataOverride.trim()) config.dataPath = resolve(dataOverride);
  else config.dataPath = anchorDataPath;

  if (typeof vaultOverride === "string" && vaultOverride.trim()) config.memory.vaultPath = resolve(vaultOverride);
  else config.memory.vaultPath = resolve(config.memory.vaultPath);

  if (typeof filesOverride === "string" && filesOverride.trim()) config.files.attachmentsPath = resolve(filesOverride);
  else config.files.attachmentsPath = resolve(config.files.attachmentsPath);

  return { anchorDataPath, settings };
}
