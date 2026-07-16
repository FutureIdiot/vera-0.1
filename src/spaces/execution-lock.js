// In-process Phase 5 execution gate. Phase 5.5 replaces the carrier with a
// federated Account lease, but the invariant is already Account-wide: a Run
// and a context compaction using the same Account must never overlap.

const accountTails = new Map();

export function withAccountExecutionLock(accountId, task) {
  const prior = accountTails.get(accountId) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(task);
  accountTails.set(accountId, next);
  const release = () => {
    if (accountTails.get(accountId) === next) accountTails.delete(accountId);
  };
  void next.then(release, release);
  return next;
}

export function hasQueuedAccountExecution(accountId) {
  return accountTails.has(accountId);
}
