// Additive Account model-selection migration. This intentionally does not
// replay the federation identity migration: it only initializes the current
// Account model from its fixed owner Agent's portable default.

export const ACCOUNT_MODEL_SELECTION_MIGRATION_VERSION = 1;

function validSelection(account) {
  if (account.ownerAgentId == null) {
    return account.model === null && account.modelVersion === 0;
  }
  return typeof account.model === "string" && Boolean(account.model) && account.model === account.model.trim() &&
    Number.isInteger(account.modelVersion) && account.modelVersion >= 1;
}

export function needsAccountModelSelectionMigration({ data }) {
  return (data.accountModelSelectionMigrationVersion ?? 0) < ACCOUNT_MODEL_SELECTION_MIGRATION_VERSION;
}

export function planAccountModelSelection({ data }) {
  const agents = new Map((data.agents ?? []).map((agent) => [agent.id, agent]));
  return (data.accounts ?? []).map((account) => {
    if (validSelection(account)) return structuredClone(account);
    if (account.ownerAgentId == null) {
      return { ...structuredClone(account), model: null, modelVersion: 0 };
    }
    const owner = agents.get(account.ownerAgentId);
    const model = typeof owner?.runtimeProfile?.model === "string" ? owner.runtimeProfile.model.trim() : "";
    if (!model || model === "default") {
      throw new Error(`Account model selection migration blocked: owner Agent ${account.ownerAgentId} has no default model`);
    }
    return { ...structuredClone(account), model, modelVersion: 1 };
  });
}

export async function migrateAccountModelSelection({ data, markDirty, flush, plan = null }) {
  if (!needsAccountModelSelectionMigration({ data })) return false;
  data.accounts = plan ?? planAccountModelSelection({ data });
  data.accountModelSelectionMigrationVersion = ACCOUNT_MODEL_SELECTION_MIGRATION_VERSION;
  markDirty(["accounts", "meta"]);
  await flush();
  return true;
}
