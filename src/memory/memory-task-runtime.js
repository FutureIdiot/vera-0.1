import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../core/errors.js";

const COLLECTION = "memoryTaskVerifications";
const TASK_KINDS = new Set(["digest", "dream"]);

function invalid(message) { return new ApiError("invalid_request", message); }
function unavailable(message) { return new ApiError("memory_task_unavailable", message); }
function stripInternal({ _seq, ...value }) { return value; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function connectionFingerprint(connection) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(connection ?? {}))).digest("hex")}`;
}
function requireTaskKind(taskKind) {
  if (!TASK_KINDS.has(taskKind)) throw invalid("taskKind must be digest or dream");
}
function requireModel(model) {
  if (typeof model !== "string" || !model.trim()) throw invalid("model must be a non-empty string");
  return model.trim();
}

export function createMemoryTaskRuntime({ store, now = () => new Date().toISOString() } = {}) {
  if (!store) throw new Error("createMemoryTaskRuntime requires store");

  function requireAgent(agentId) {
    const agent = store.find("agents", agentId);
    if (!agent) throw new ApiError("not_found", `agent ${agentId} does not exist`);
    return agent;
  }
  function homeAccount(executorAgentId) {
    requireAgent(executorAgentId);
    const accounts = store.list("accounts").filter((account) => account.owningAgentId === executorAgentId);
    if (accounts.length !== 1) {
      throw unavailable(`executor Agent ${executorAgentId} does not have exactly one Phase 5 Home Account`);
    }
    const account = accounts[0];
    if (typeof account.kind !== "string" || !account.kind || typeof account.provider !== "string" || !account.provider) {
      throw unavailable(`executor Agent ${executorAgentId} Home Account is unavailable`);
    }
    return account;
  }
  function currentVerification({ taskKind, executorAgentId, account, model }) {
    const fingerprint = connectionFingerprint(account.connection);
    return [...store.list(COLLECTION)].reverse().find((record) =>
      record.taskKind === taskKind && record.executorAgentId === executorAgentId &&
      record.accountId === account.id && record.kind === account.kind && record.provider === account.provider &&
      record.model === model && record.connectionFingerprint === fingerprint) ?? null;
  }
  function recordVerification({ taskKind, executorAgentId, model }) {
    requireTaskKind(taskKind);
    const account = homeAccount(executorAgentId);
    const taskModel = requireModel(model);
    const record = store.insert(COLLECTION, {
      id: `mtv_${randomUUID().replaceAll("-", "")}`,
      taskKind,
      executorAgentId,
      accountId: account.id,
      kind: account.kind,
      provider: account.provider,
      model: taskModel,
      connectionFingerprint: connectionFingerprint(account.connection),
      verifiedAt: now(),
    });
    return stripInternal(record);
  }
  function resolveTaskSnapshot({ ownerAgentId, taskKind, taskConfig }) {
    requireAgent(ownerAgentId);
    requireTaskKind(taskKind);
    if (!taskConfig || typeof taskConfig !== "object" || Array.isArray(taskConfig)) throw invalid("taskConfig must be an object");
    const executorAgentId = taskConfig.executorAgentId ?? ownerAgentId;
    const account = homeAccount(executorAgentId);
    if (!new Set(["inherit", "fixed"]).has(taskConfig.modelMode)) throw invalid("modelMode must be inherit or fixed");
    let taskModel;
    if (taskConfig.modelMode === "inherit") {
      if (taskConfig.model !== null) throw invalid("inherit task config model must be null");
      taskModel = String(account.model ?? "").trim();
      if (!taskModel) throw unavailable("executor Home Account has no default chat model to inherit");
    } else {
      taskModel = requireModel(taskConfig.model);
    }
    const verification = currentVerification({ taskKind, executorAgentId, account, model: taskModel });
    if (!verification) throw unavailable(`${taskKind} task model is not verified for the executor Home Account`);
    return {
      ownerAgentId,
      executorAgentId,
      accountId: account.id,
      kind: account.kind,
      provider: account.provider,
      modelMode: taskConfig.modelMode,
      taskModel,
      verificationId: verification.id,
      connectionFingerprint: verification.connectionFingerprint,
    };
  }
  function optionsFor(taskKind) {
    requireTaskKind(taskKind);
    const executors = store.list("agents").map((agent) => {
      const accounts = store.list("accounts").filter((account) => account.owningAgentId === agent.id);
      if (accounts.length !== 1) {
        return { agentId: agent.id, name: agent.name, availability: "unavailable", models: [] };
      }
      const account = accounts[0];
      const fingerprint = connectionFingerprint(account.connection);
      const latestByModel = new Map();
      for (const record of store.list(COLLECTION)) {
        if (record.taskKind !== taskKind || record.executorAgentId !== agent.id || record.accountId !== account.id ||
            record.kind !== account.kind || record.provider !== account.provider || record.connectionFingerprint !== fingerprint) continue;
        latestByModel.set(record.model, record);
      }
      const models = [...latestByModel.values()].sort((a, b) => a.model.localeCompare(b.model)).map((record) => ({
        model: record.model,
        verificationId: record.id,
      }));
      return { agentId: agent.id, name: agent.name, availability: models.length ? "available" : "unavailable", models };
    });
    return { executors };
  }
  function listOptions({ ownerAgentId, taskKind } = {}) {
    requireAgent(ownerAgentId);
    if (taskKind !== undefined) return optionsFor(taskKind);
    return { digest: optionsFor("digest"), dream: optionsFor("dream") };
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw unavailable("Memory task snapshot is unavailable");
    requireAgent(snapshot.ownerAgentId);
    const account = homeAccount(snapshot.executorAgentId);
    if (account.id !== snapshot.accountId || account.kind !== snapshot.kind || account.provider !== snapshot.provider) {
      throw unavailable("Memory task execution route changed after enqueue");
    }
    const fingerprint = connectionFingerprint(account.connection);
    const verification = store.find(COLLECTION, snapshot.verificationId);
    if (!verification || !TASK_KINDS.has(verification.taskKind) || verification.executorAgentId !== snapshot.executorAgentId ||
        verification.accountId !== account.id || verification.kind !== account.kind || verification.provider !== account.provider ||
        verification.model !== snapshot.taskModel || verification.connectionFingerprint !== fingerprint ||
        snapshot.connectionFingerprint !== fingerprint) {
      throw unavailable("Memory task verification is no longer valid");
    }
    return {
      account: Object.fromEntries(["id", "kind", "provider", "connection", "model"].map((key) => [key, structuredClone(account[key])])),
      taskModel: snapshot.taskModel,
    };
  }

  return { resolveTaskSnapshot, validateSnapshot, listOptions, recordVerification, connectionFingerprint };
}
