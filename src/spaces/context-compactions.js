import { ApiError } from "../core/errors.js";
import { getOwningAccount } from "../agents/accounts.js";
import { ensureAgentSession, getActiveContext, projectAgentSession } from "./context-sessions.js";
import {
  createContextCompactionJob,
  getContextCompactionJob,
  getContextCompactionTarget,
  markContextCompactionTargetRunning,
  recoverInterruptedContextCompactions,
  updateContextCompactionTarget,
} from "./context-compaction-store.js";
import { withAccountExecutionLock } from "./execution-lock.js";
import { checkpointForAgent } from "./run-context.js";
import { getProviderBinding } from "./context-state.js";

export function createContextCompactionService({ store, hub, config, dispatchDaemonCompaction = null }) {
  const inFlight = new Map();
  const daemonResults = new Map();
  recoverInterruptedContextCompactions(store);

  function publicSession(agentSessionId) {
    const session = store.find("agentSessions", agentSessionId);
    return session ? projectAgentSession(session) : null;
  }

  function publish(job, agentSessionId) {
    hub.publish("agent-session.compaction.updated", {
      spaceId: job.spaceId,
      spaceSessionId: job.spaceSessionId,
      jobId: job.id,
      agentSession: publicSession(agentSessionId),
    });
  }

  async function runTarget(jobId, agentId) {
    const key = `${jobId}:${agentId}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      let job = getContextCompactionJob(store, jobId);
      const target = job ? getContextCompactionTarget(store, { jobId, agentId }) : null;
      if (!job || !target || !["queued", "running"].includes(target.status)) return job;
      const account = store.find("accounts", target.accountId);
      if (!account) {
        job = updateContextCompactionTarget(store, {
          jobId, agentId,
          agentSessionId: target.agentSessionId,
          fromGeneration: target.fromGeneration,
          status: "failed",
          error: { code: "context_capacity", message: "Agent has no Home Account" },
        });
        publish(job, target.agentSessionId);
        return job;
      }
      return withAccountExecutionLock(account.id, async () => {
        job = markContextCompactionTargetRunning(store, { jobId, agentId });
        publish(job, target.agentSessionId);
        try {
          const current = store.find("agentSessions", target.agentSessionId);
          if (!current || current.generation !== target.fromGeneration) {
            throw new ApiError("history_conflict", "AgentSession generation changed before compaction");
          }
          const checkpoint = checkpointForAgent(store, {
            spaceSessionId: current.spaceSessionId,
            agentId,
            recentTurnLimit: target.recentTurnLimit,
            maxChars: config.viewCompiler.groupDeltaMaxChars,
            sourceSeq: target.sourceSeq,
            includedRunIds: target.includedRunIds,
          });
          if (dispatchDaemonCompaction) {
            const resultKey = `${jobId}:${agentId}`;
            const result = new Promise((resolve, reject) => {
              const timeoutMs = config.agentDaemon?.sessionTimeoutMs ?? 45000;
              const timer = setTimeout(() => {
                daemonResults.delete(resultKey);
                reject(new ApiError("context_capacity", "Context compaction daemon timed out"));
              }, timeoutMs);
              timer.unref?.();
              daemonResults.set(resultKey, {
                resolve(value) { clearTimeout(timer); resolve(value); },
                cancel() { clearTimeout(timer); },
              });
            });
            const input = target.mode === "native"
              ? {
                providerBinding: getProviderBinding(store, {
                  agentSessionId: current.id,
                  generation: current.generation,
                  accountId: account.id,
                }),
              }
              : { checkpoint };
            try {
              dispatchDaemonCompaction({
                accountId: account.id,
                event: {
                  type: "agent-session.compact.requested",
                  data: {
                    jobId,
                    target: {
                      agentId,
                      agentSessionId: current.id,
                      fromGeneration: current.generation,
                      mode: target.mode,
                    },
                    account: { id: account.id, name: account.name, ownerAgentId: account.ownerAgentId },
                    input,
                  },
                },
              });
              return await result;
            } finally {
              daemonResults.get(resultKey)?.cancel?.();
              daemonResults.delete(resultKey);
            }
          }
          job = updateContextCompactionTarget(store, {
            jobId,
            agentId,
            agentSessionId: current.id,
            fromGeneration: current.generation,
            status: "succeeded",
            checkpoint,
          });
          publish(job, current.id);
          return job;
        } catch (error) {
          job = updateContextCompactionTarget(store, {
            jobId,
            agentId,
            agentSessionId: target.agentSessionId,
            fromGeneration: target.fromGeneration,
            status: "failed",
            error: {
              code: error?.code === "history_conflict" ? "history_conflict" : "context_capacity",
              message: "Context compaction failed",
            },
          });
          publish(job, target.agentSessionId);
          return job;
        }
      });
    })();
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }

  function enqueue({ spaceId, requestId }) {
    const space = store.find("spaces", spaceId);
    if (!space) throw new ApiError("not_found", `space ${spaceId} does not exist`);
    const targets = (space.seats ?? []).map((seat) => {
      const account = store.find("accounts", seat.accountId);
      if (!account?.ownerAgentId) throw new ApiError("conflict", `account ${seat.accountId} has no owner Agent`);
      const { agentSession } = getActiveContext(store, {
        spaceId, accountId: account.id, agentId: account.ownerAgentId,
      });
      return {
        agentId: account.ownerAgentId,
        accountId: account.id,
        agentSessionId: agentSession.id,
        fromGeneration: agentSession.generation,
        recentTurnLimit: config.context.checkpointRecentTurns,
      };
    });
    const job = createContextCompactionJob(store, { spaceId, requestId, targets });
    for (const target of job.targets) void runTarget(job.id, target.agentId);
    return job;
  }

  async function compactAgent({ spaceId, agentId, requestId }) {
    const account = getOwningAccount(store, agentId);
    if (!account) throw new ApiError("conflict", `agent ${agentId} has no owner Account`);
    const { agentSession } = getActiveContext(store, { spaceId, accountId: account.id, agentId });
    ensureAgentSession(store, { spaceSessionId: agentSession.spaceSessionId, accountId: account.id, agentId });
    const job = createContextCompactionJob(store, {
      spaceId,
      requestId,
      targets: [{
        agentId,
        accountId: account.id,
        agentSessionId: agentSession.id,
        fromGeneration: agentSession.generation,
        recentTurnLimit: config.context.checkpointRecentTurns,
      }],
    });
    await runTarget(job.id, agentId);
    const completed = getContextCompactionJob(store, job.id);
    const target = completed.targets.find((item) => item.agentId === agentId);
    if (target.status !== "succeeded") {
      throw new ApiError("context_capacity", "Context could not be compacted safely");
    }
    return store.find("agentSessions", agentSession.id);
  }

  function submitDaemonResult({ job, target, input }) {
    const updated = updateContextCompactionTarget(store, {
      jobId: job.id,
      agentId: target.agentId,
      ...input,
    });
    publish(updated, target.agentSessionId);
    daemonResults.get(`${job.id}:${target.agentId}`)?.resolve(updated);
    return updated;
  }

  return {
    enqueue,
    compactAgent,
    submitDaemonResult,
    getJob: (jobId) => getContextCompactionJob(store, jobId),
  };
}
