import { setupFingerprint } from "./setup-state.js";

const operationHandlers = new WeakMap();

function operationError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function defineSetupOperation({ id, detect, diff, apply, verify, destructive = false, backup = null }) {
  if (!/^[a-z][a-z0-9.-]*$/u.test(id ?? "") || ![detect, diff, apply, verify].every((fn) => typeof fn === "function")) {
    throw operationError("setup operation requires an id and detect/diff/apply/verify functions", "invalid_setup_operation");
  }
  if (destructive && typeof backup !== "function") {
    throw operationError("destructive setup operations require a backup function", "invalid_setup_operation");
  }
  const operation = Object.freeze({ id, destructive });
  operationHandlers.set(operation, { detect, diff, apply, verify, backup });
  return operation;
}

export async function previewSetupOperation(operation, context) {
  const handlers = operationHandlers.get(operation);
  if (!handlers) throw operationError("unknown setup operation", "invalid_setup_operation");
  const detected = await handlers.detect(context);
  const difference = await handlers.diff(detected, context);
  return Object.freeze({
    operationId: operation.id,
    detected,
    difference,
    detectionFingerprint: setupFingerprint({ operationId: operation.id, detected, difference }),
  });
}

// 第一切片只允许 detect + diff 形成计划。apply/verify/backup只存在于模块私有闭包，
// operation对象不暴露mutator；权威confirmed session落地前没有任何执行入口。
