// Per-Agent FIFO for every programmatic Memory mutation. Queue failures are
// isolated: one rejected operation must not poison later work for that Agent.

export function createMemoryWriteQueue() {
  const tails = new Map();
  const pendingByEpoch = new Map();
  let admission = Promise.resolve();
  let exclusiveTail = Promise.resolve();
  let epoch = 0;

  function track(epochNumber, promise) {
    let pending = pendingByEpoch.get(epochNumber);
    if (!pending) {
      pending = new Set();
      pendingByEpoch.set(epochNumber, pending);
    }
    pending.add(promise);
    const cleanup = () => {
      pending.delete(promise);
      if (pending.size === 0) pendingByEpoch.delete(epochNumber);
    };
    promise.then(cleanup, cleanup);
  }

  function enqueue(agentId, task) {
    const gate = admission;
    const admittedEpoch = epoch;
    const result = gate.then(() => {
      const previous = tails.get(agentId) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(task);
      const tail = operation.catch(() => {});
      tails.set(agentId, tail);
      tail.finally(() => {
        if (tails.get(agentId) === tail) tails.delete(agentId);
      });
      return operation;
    });
    track(admittedEpoch, result);
    return result;
  }

  async function drain(agentId) {
    if (agentId !== undefined) await (tails.get(agentId) ?? Promise.resolve());
    else while (tails.size > 0) await Promise.all([...tails.values()]);
  }

  async function runExclusive(task) {
    const closedEpoch = epoch;
    epoch += 1;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    admission = admission.then(() => blocked);
    try {
      while (pendingByEpoch.get(closedEpoch)?.size) {
        await Promise.allSettled([...pendingByEpoch.get(closedEpoch)]);
      }
      await drain();
      return await task();
    } finally {
      release();
    }
  }

  function withExclusive(task) {
    const result = exclusiveTail.catch(() => {}).then(() => runExclusive(task));
    exclusiveTail = result.catch(() => {});
    return result;
  }

  return { enqueue, drain, withExclusive };
}
