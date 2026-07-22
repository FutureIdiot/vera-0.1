import { createHash } from "node:crypto";

export const SETUP_STAGES = Object.freeze([
  "target_collected",
  "preflighted",
  "planned",
  "confirmed",
  "backed_up",
  "host_prepared",
  "tailnet_ready",
  "network_hardened",
  "gateway_applied",
  "gateway_verified",
  "daemon_applied",
  "completed",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function setupFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function requireStage(session, stage) {
  if (session.stage !== stage) {
    throw Object.assign(new Error(`setup stage must be ${stage}`), { code: "invalid_setup_transition" });
  }
}

export function createSetupSession(input) {
  return Object.freeze({
    stage: "target_collected",
    lastCompletedStage: "target_collected",
    inputFingerprint: setupFingerprint(input),
    snapshots: [],
    plan: null,
    applied: false,
  });
}

export function recordSetupPreflight(session, snapshots) {
  requireStage(session, "target_collected");
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw Object.assign(new Error("setup requires at least one preflight snapshot"), { code: "invalid_setup_transition" });
  }
  return Object.freeze({
    ...session,
    stage: "preflighted",
    lastCompletedStage: "preflighted",
    snapshots: Object.freeze([...snapshots]),
    snapshotFingerprint: setupFingerprint({ inputFingerprint: session.inputFingerprint, snapshots }),
  });
}

export function recordSetupPlan(session, plan) {
  requireStage(session, "preflighted");
  if (!plan || plan.snapshotFingerprint !== session.snapshotFingerprint) {
    throw Object.assign(new Error("setup plan does not match the current preflight snapshot"), { code: "stale_setup_plan" });
  }
  return Object.freeze({
    ...session,
    stage: "planned",
    lastCompletedStage: "planned",
    plan,
  });
}
