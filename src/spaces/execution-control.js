// Session revocation terminalizes Account work before a later owner login.

export function releaseAccountExecutions(store, accountId) {
  const endedAt = new Date().toISOString();
  for (const run of store.list("runs")) {
    if (run.accountId !== accountId || !["pending", "running"].includes(run.status)) continue;
    store.update("runs", run.id, {
      status: "failed",
      endedAt,
      error: { code: "internal", message: "Account Session was revoked" },
    });
    for (const message of store.list("messages")) {
      if (message.runId === run.id && message.status === "streaming") {
        store.update("messages", message.id, { status: "failed" });
      }
    }
    for (const approval of store.list("approvals")) {
      if (approval.runId === run.id && approval.status === "pending") {
        store.update("approvals", approval.id, { status: "expired", answer: "deny" });
      }
    }
  }
}
