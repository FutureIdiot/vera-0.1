// AccountSession state is process-local. A fresh Gateway process therefore
// cannot retain a persisted online Account until its daemon reauthorizes.

export function recoverAccountPresence(store, { now = new Date().toISOString() } = {}) {
  let recovered = 0;
  for (const account of store.list("accounts")) {
    if (account.presence !== "online") continue;
    store.update("accounts", account.id, {
      presence: "offline",
      activeAgentId: null,
      runtimeCapabilities: null,
      lastSeenAt: now,
      updatedAt: now,
    });
    recovered += 1;
  }
  return recovered;
}
