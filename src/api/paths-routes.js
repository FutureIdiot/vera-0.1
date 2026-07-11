// Path summary, validation, and controlled migration routes. Filesystem work is
// kept in path-migrations.js so this route module only parses HTTP parameters.

import { asHandler, readJsonBody, sendJson } from "./http.js";
import { ApiError } from "../core/errors.js";
import { dirSize, validatePathTarget } from "./path-validation.js";
import { migrateDataPath, migrateVaultPath } from "./path-migrations.js";

const EDITABLE_KEYS = new Set(["memory.vaultPath", "gateway.dataPath"]);

function requireKey(key) {
  if (!EDITABLE_KEYS.has(key)) {
    throw new ApiError("invalid_request", `key must be one of: ${[...EDITABLE_KEYS].join(", ")}`);
  }
}

export function registerPathsRoutes(router, dependencies) {
  const { config, memory } = dependencies;

  router.get(
    "/api/paths",
    asHandler(async ({ res }) => {
      const memorySummary = await memory.inspect();
      const configuredTarget = dependencies.settingsStore.get("paths.gateway.dataPath");
      sendJson(res, 200, {
        paths: {
          memory: { vaultPath: memory.getVaultPath(), ...memorySummary },
          gateway: {
            dataPath: config.dataPath,
            sizeBytes: await dirSize(config.dataPath),
            restartRequired: typeof configuredTarget === "string" && configuredTarget !== config.dataPath,
          },
        },
      });
    }),
  );

  router.post(
    "/api/paths/validate",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      requireKey(body.key);
      if (typeof body.value !== "string" || !body.value.trim()) {
        throw new ApiError("invalid_request", "value must be a non-empty string");
      }
      sendJson(res, 200, await validatePathTarget({ ...dependencies, key: body.key, value: body.value }));
    }),
  );

  router.post(
    "/api/paths/migrate",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      requireKey(body.key);
      if (typeof body.target !== "string" || !body.target.trim()) {
        throw new ApiError("invalid_request", "target must be a non-empty string");
      }
      const validation = await validatePathTarget({ ...dependencies, key: body.key, value: body.target });
      if (!validation.ok) throw new ApiError("invalid_request", validation.errors.join("; "));
      const result = body.key === "memory.vaultPath"
        ? await migrateVaultPath({ ...dependencies, target: validation.normalized })
        : await migrateDataPath({ ...dependencies, target: validation.normalized });
      sendJson(res, 200, result);
    }),
  );
}
