const CURRENT_VERSION = 1;

function fail(message) {
  throw new Error(`agent communication migration failed: ${message}`);
}

export function needsAgentCommunicationMigration({ data }) {
  return (data.agentCommunicationMigrationVersion ?? 0) < CURRENT_VERSION;
}

export function planAgentCommunicationMigration({ data }) {
  if (!needsAgentCommunicationMigration({ data })) {
    return {
      spaces: structuredClone(data.spaces ?? []),
      runs: structuredClone(data.runs ?? []),
    };
  }

  const spaces = structuredClone(data.spaces ?? []);
  for (const space of spaces) {
    for (const seat of space.seats ?? []) {
      if (seat.responseMode === "silent") seat.responseMode = "focused";
      else if (seat.responseMode === "focused") seat.responseMode = "mentioned";
      else if (seat.responseMode !== undefined && seat.responseMode !== "default") {
        fail(`space ${space.id} has unknown responseMode ${seat.responseMode}`);
      }
      seat.responseMode ??= "default";
    }
  }

  const runs = structuredClone(data.runs ?? []);
  const byId = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) {
    if (run.role === "main") run.role = "root";
    else if (run.role === "subagent") run.role = "child";
    else if (!["root", "child"].includes(run.role)) {
      fail(`run ${run.id} has unknown role ${run.role}`);
    }
  }

  const visiting = new Set();
  const resolved = new Set();
  function resolve(run) {
    if (resolved.has(run.id)) return;
    if (visiting.has(run.id)) fail(`run ${run.id} is part of a parent cycle`);
    visiting.add(run.id);
    if (run.role === "root") {
      if (run.parentRunId !== null) fail(`root run ${run.id} has a parent`);
      run.rootRunId = run.id;
      run.depth = 0;
    } else {
      if (typeof run.parentRunId !== "string") fail(`child run ${run.id} has no parent`);
      const parent = byId.get(run.parentRunId);
      if (!parent) fail(`child run ${run.id} references missing parent ${run.parentRunId}`);
      resolve(parent);
      if (parent.spaceId !== run.spaceId || parent.spaceSessionId !== run.spaceSessionId) {
        fail(`child run ${run.id} crosses its parent Space session`);
      }
      run.rootRunId = parent.rootRunId;
      run.depth = parent.depth + 1;
    }
    run.outputPolicy = run.role === "child" || run.backgroundedAt ? "source" : "space";
    run.deferredByRunId ??= null;
    run.catchupId ??= null;
    visiting.delete(run.id);
    resolved.add(run.id);
  }
  for (const run of runs) resolve(run);
  return { spaces, runs };
}

export async function migrateAgentCommunication({ data, markDirty, flush, plan }) {
  if (!needsAgentCommunicationMigration({ data })) return false;
  const next = plan ?? planAgentCommunicationMigration({ data });
  data.spaces = next.spaces;
  data.runs = next.runs;
  data.agentCommunicationMigrationVersion = CURRENT_VERSION;
  markDirty(["spaces", "runs", "meta"]);
  await flush();
  return true;
}
