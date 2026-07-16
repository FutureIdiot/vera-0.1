// Read-only integrity check used by gateway.dataPath migration. It deliberately
// does not call createStore(), because the normal loader may perform migrations
// and writes; validation must not mutate the candidate truth source.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ARRAY_FILES = new Set([
  "agents.json", "accounts.json", "spaces.json", "messages.json",
  "activities.json", "approvals.json", "runs.json", "themes.json",
  "memoryDigestJobs.json", "memoryRecallSessions.json", "memorySignals.json",
  "unitBindings.json", "memoryConfigs.json", "memoryTaskVerifications.json",
  "memoryDreamJobs.json",
  "spaceSessions.json", "agentSessions.json", "providerBindings.json",
  "apiHistories.json", "contextCompactionJobs.json", "contextControlRequests.json",
  "files.json",
]);
const OBJECT_FILES = new Set(["session-states.json", "meta.json", "settings.json"]);
const RECOGNIZED_FILES = new Set([...ARRAY_FILES, ...OBJECT_FILES]);

export async function validateStoreDirectory(dataPath) {
  const entries = await readdir(dataPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".legacy")) continue;
    if (!RECOGNIZED_FILES.has(entry.name)) throw new Error(`unrecognized store file: ${entry.name}`);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(join(dataPath, entry.name), "utf8"));
    } catch {
      throw new Error(`invalid JSON in ${entry.name}`);
    }
    if (ARRAY_FILES.has(entry.name) && !Array.isArray(parsed)) throw new Error(`${entry.name} must contain an array`);
    if (OBJECT_FILES.has(entry.name) && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
      throw new Error(`${entry.name} must contain an object`);
    }
  }
  return true;
}
