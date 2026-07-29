import test from "node:test";
import assert from "node:assert/strict";

import {
  needsAgentCommunicationMigration,
  planAgentCommunicationMigration,
} from "../../src/store/migrations/agent-communication.mjs";

test("Agent communication migration renames modes and reconstructs a strict Root/Child tree once", () => {
  const data = {
    agentCommunicationMigrationVersion: 0,
    spaces: [{
      id: "spc_one",
      seats: [
        { accountId: "acc_a", responseMode: "silent", respondTo: ["user"] },
        { accountId: "acc_b", responseMode: "focused" },
      ],
    }],
    runs: [{
      id: "run_root",
      role: "main",
      parentRunId: null,
      spaceId: "spc_one",
      spaceSessionId: "sps_one",
      backgroundedAt: null,
    }, {
      id: "run_child",
      role: "subagent",
      parentRunId: "run_root",
      spaceId: "spc_one",
      spaceSessionId: "sps_one",
      backgroundedAt: null,
    }],
  };
  assert.equal(needsAgentCommunicationMigration({ data }), true);
  const planned = planAgentCommunicationMigration({ data });
  assert.deepEqual(planned.spaces[0].seats.map((seat) => seat.responseMode), [
    "focused", "mentioned",
  ]);
  assert.deepEqual(
    planned.runs.map((run) => ({
      role: run.role,
      rootRunId: run.rootRunId,
      parentRunId: run.parentRunId,
      depth: run.depth,
      outputPolicy: run.outputPolicy,
    })),
    [{
      role: "root",
      rootRunId: "run_root",
      parentRunId: null,
      depth: 0,
      outputPolicy: "space",
    }, {
      role: "child",
      rootRunId: "run_root",
      parentRunId: "run_root",
      depth: 1,
      outputPolicy: "source",
    }],
  );
  assert.equal(data.runs[0].role, "main", "planning does not mutate the source store");
});

test("Agent communication migration refuses an unverifiable Child parent chain", () => {
  assert.throws(
    () => planAgentCommunicationMigration({
      data: {
        agentCommunicationMigrationVersion: 0,
        spaces: [],
        runs: [{
          id: "run_child",
          role: "subagent",
          parentRunId: "run_missing",
          spaceId: "spc_one",
          spaceSessionId: "sps_one",
        }],
      },
    }),
    /missing parent/u,
  );
});
