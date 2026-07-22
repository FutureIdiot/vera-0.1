import { collectSetupPreflight } from "./setup-preflight.js";
import { buildSetupPlan } from "./setup-plan.js";
import { normalizeSetupInput, parseSetupArgs, setupUsage } from "./setup-input.js";
import { createSetupSession, recordSetupPlan, recordSetupPreflight } from "./setup-state.js";

function writeLine(stream, value = "") {
  stream.write(`${value}\n`);
}

function safeError(error) {
  const knownCodes = new Set([
    "invalid_setup_input",
    "preflight_failed",
    "preflight_timeout",
    "preflight_invalid_output",
    "invalid_setup_plan",
  ]);
  const code = knownCodes.has(error?.code) ? error.code : "setup_failed";
  const messages = {
    invalid_setup_input: error?.message ?? "setup input is invalid",
    preflight_failed: "目标宿主不可达或拒绝了固定只读探针",
    preflight_timeout: "目标宿主只读探针超时",
    preflight_invalid_output: "目标宿主返回了不完整或不可信的探针结果",
    invalid_setup_plan: "无法从当前事实生成部署计划",
    setup_failed: "setup发生内部错误",
  };
  return { code, message: messages[code] };
}

export function renderSetupPlan(plan, stream) {
  writeLine(stream, "Vera setup：只读预检与部署计划");
  writeLine(stream, `阶段: ${plan.stage}`);
  writeLine(stream, `分类: ${plan.status}`);
  writeLine(stream, `计划ID: ${plan.planId}`);
  writeLine(stream, `Tailnet路径: ${plan.tailnet}`);
  writeLine(stream, `Owner login: ${plan.ownerLogin}`);
  for (const target of plan.targets) {
    writeLine(stream);
    writeLine(stream, `目标 ${target.id}: ${target.role} / ${target.transport}`);
    for (const item of target.checks) writeLine(stream, `  [${item.status}] ${item.summary} — ${item.detail}`);
    writeLine(stream, "  后续操作计划:");
    for (const action of target.actions) {
      writeLine(stream, `    [${action.status}] ${action.id}: ${action.action}`);
      writeLine(stream, `      备份: ${action.backup}`);
      writeLine(stream, `      验证: ${action.verify}`);
    }
  }
  writeLine(stream);
  writeLine(stream, "本次执行停在 planned；applied=false。未安装包、未写文件、未改变service、防火墙、SSH或Tailscale。");
  writeLine(stream, "confirmed及后续apply尚未开放，不能把本结果视为已部署。可修复项和阻断项处理后请重跑同一入口。");
}

function jsonProjection(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    stage: plan.stage,
    status: plan.status,
    planId: plan.planId,
    snapshotFingerprint: plan.snapshotFingerprint,
    tailnet: plan.tailnet,
    ownerLogin: plan.ownerLogin,
    targets: plan.targets,
    applied: false,
  };
}

export async function runSetup({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  collectPreflight = collectSetupPreflight,
} = {}) {
  let format = argv.includes("--json") ? "json" : "text";
  let session = null;
  try {
    const parsed = parseSetupArgs(argv);
    if (parsed.help) {
      writeLine(stdout, setupUsage);
      return 0;
    }
    if (argv.length === 0) {
      writeLine(stderr, setupUsage);
      return 64;
    }
    const input = normalizeSetupInput(parsed.values);
    format = input.format;
    session = createSetupSession(input);
    const snapshots = await Promise.all(input.targets.map((target) => collectPreflight(target)));
    session = recordSetupPreflight(session, snapshots);
    const plan = buildSetupPlan(input, snapshots, session.snapshotFingerprint);
    session = recordSetupPlan(session, plan);
    if (format === "json") writeLine(stdout, JSON.stringify(jsonProjection(plan), null, 2));
    else renderSetupPlan(plan, stdout);
    return plan.status === "blocked" ? 2 : 0;
  } catch (error) {
    const safe = safeError(error);
    const failure = {
      stage: session?.lastCompletedStage ?? null,
      status: "blocked",
      applied: false,
      error: safe,
    };
    if (format === "json") writeLine(stderr, JSON.stringify(failure));
    else writeLine(stderr, `${safe.code}: ${safe.message}`);
    return error?.code === "invalid_setup_input" ? 64 : 1;
  }
}
