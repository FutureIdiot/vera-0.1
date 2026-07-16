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

export function createContextCompactionService({ store, hub, config }) {
  const inFlight = new Map();
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
      const account = getOwningAccount(store, agentId);
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
      const { agentSession } = getActiveContext(store, { spaceId, agentId: seat.agentId });
      return {
        agentId: seat.agentId,
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
    const { agentSession } = getActiveContext(store, { spaceId, agentId });
    ensureAgentSession(store, { spaceSessionId: agentSession.spaceSessionId, agentId });
    const job = createContextCompactionJob(store, {
      spaceId,
      requestId,
      targets: [{
        agentId,
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

  return { enqueue, compactAgent, getJob: (jobId) => getContextCompactionJob(store, jobId) };
}
