// Approval：requestApproval -> 卡片入时间线 -> answer endpoint 回填 resolve；
// run 结束仍未答复标 expired 并 resolve "deny"（docs/adapter-interface.md /
// api-contract.md Approval 一节）。
//
// resolvers 是模块级注册表：requestApproval 在 run-controller 的执行上下文里
// 调用（等待 adapter 的 Promise），而 answerApproval 由完全独立的 HTTP 请求
// （POST /api/approvals/:id/answer）触发，两者必须能找到同一个 pending 的
// resolve 函数，所以用 approvalId 做键的模块级 Map。

import { newApprovalId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

const resolvers = new Map(); // approvalId -> resolve(answer)

function stripInternal({ _seq, ...rest }) {
  return rest;
}

// 提权申请：由 run-controller 包一层 ctx.requestApproval 调用。
export function requestApproval({ store, hub, spaceId, spaceSessionId, runId, agentId, req }) {
  const approval = {
    id: newApprovalId(),
    spaceId,
    spaceSessionId,
    runId,
    agentId,
    prompt: req?.prompt ?? "",
    options: req?.options ?? ["allow", "deny"],
    status: "pending",
    answer: null,
    createdAt: new Date().toISOString(),
  };
  const stored = store.insert("approvals", approval);
  hub.publish("approval.requested", { approval: stripInternal(stored) });
  return new Promise((resolve) => {
    resolvers.set(stored.id, resolve);
  });
}

// POST /api/approvals/:id/answer。幂等；非 pending 返回 409 conflict。
export function answerApproval(store, hub, id, answer) {
  const approval = store.find("approvals", id);
  if (!approval) throw new ApiError("not_found", `approval ${id} does not exist`);
  if (approval.status !== "pending") {
    throw new ApiError("conflict", `approval ${id} is already ${approval.status}`);
  }
  const updated = store.update("approvals", id, { status: "answered", answer });
  hub.publish("approval.answered", { approval: stripInternal(updated) });
  const resolve = resolvers.get(id);
  if (resolve) {
    resolve(answer);
    resolvers.delete(id);
  }
  return stripInternal(updated);
}

// run 结束时调用：把该 run 下仍 pending 的 approval 标 expired，resolve "deny"。
export function expirePendingApprovalsForRun(store, hub, runId) {
  const pending = store.list("approvals").filter((a) => a.runId === runId && a.status === "pending");
  for (const approval of pending) {
    const updated = store.update("approvals", approval.id, { status: "expired", answer: "deny" });
    hub?.publish("approval.answered", { approval: stripInternal(updated) });
    const resolve = resolvers.get(approval.id);
    if (resolve) {
      resolve("deny");
      resolvers.delete(approval.id);
    }
  }
}
