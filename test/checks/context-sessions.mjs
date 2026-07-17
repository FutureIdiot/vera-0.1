// P5-C1 SpaceSession / AgentSession black-box checks. These use a dedicated
// Space so `/new` and compaction never disturb the shared Phase 2 verify flow.

function itemIds(timeline) {
  return new Set(timeline.json.items.map((item) => item.id));
}

function assertTimelineSession(assert, timeline, spaceSessionId, label) {
  assert(timeline.json.spaceSession?.id === spaceSessionId,
    `${label} should project SpaceSession ${spaceSessionId}`);
  for (const item of timeline.json.items) {
    assert(item.spaceSessionId === spaceSessionId,
      `${label} item ${item.id} leaked from ${item.spaceSessionId}`);
  }
}

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse } = ctx;
  let space;
  let firstSessionId;
  let secondSessionId;
  let firstMessageId;
  let firstReplyIds;

  await check("p5-c1.1 Space creation establishes one active SpaceSession", async () => {
    const created = await httpRequest("POST", "/api/spaces", {
      name: "p5-c1-context-space",
      topic: "SpaceSession isolation",
      seats: [{ accountId: ctx.owningAccount.id, responseMode: "default" }],
    });
    assertEqual(created.status, 201);
    space = created.json.space;
    const active = await httpRequest("GET", `/api/spaces/${space.id}/sessions?status=active`);
    assertEqual(active.status, 200);
    assertEqual(active.json.sessions.length, 1);
    assertEqual(active.json.sessions[0].status, "active");
    firstSessionId = active.json.sessions[0].id;
  });

  await check("p5-c1.2 Message, Run and SSE records carry the active spaceSessionId", async () => {
    const posted = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "old window message",
    });
    assertEqual(posted.status, 201);
    assertEqual(posted.json.message.spaceSessionId, firstSessionId);
    assertEqual(posted.json.runs.length, 1);
    assertEqual(posted.json.runs[0].spaceSessionId, firstSessionId);
    assert(posted.json.runs[0].agentSessionId?.startsWith("ags_"), "main Run should freeze agentSessionId");
    assertEqual(posted.json.runs[0].contextGeneration, 1);
    firstMessageId = posted.json.message.id;

    const ended = await sse.waitFor(
      (event) => event.type === "run.ended" && event.data.run.id === posted.json.runs[0].id,
      10000,
    );
    assertEqual(ended.data.run.status, "completed");
    assertEqual(ended.data.run.spaceSessionId, firstSessionId);
    assertEqual(ended.data.run.agentSessionId, posted.json.runs[0].agentSessionId);
    assertEqual(ended.data.run.contextGeneration, posted.json.runs[0].contextGeneration);
    firstReplyIds = ended.data.run.replyMessageIds;

    const related = sse.events.filter((event) => {
      const record = event.data?.run ?? event.data?.message ?? event.data?.activity ?? event.data?.approval;
      return record?.runId === ended.data.run.id || record?.id === ended.data.run.id;
    });
    assert(related.length > 0, "expected SSE records for the P5-C1 Run");
    for (const event of related) {
      const record = event.data.run ?? event.data.message ?? event.data.activity ?? event.data.approval;
      const sessionId = record?.spaceSessionId ?? event.data.spaceSessionId;
      assertEqual(sessionId, firstSessionId, `${event.type} should carry the frozen SpaceSession`);
    }
  });

  await check("p5-c1.3 exact /new and /compact are rejected by the Message endpoint", async () => {
    const before = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    assertEqual(before.status, 200);
    const attempts = [];
    for (const command of ["/new", "  /new \n", "/compact", "\t/compact\n"]) {
      const rejected = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
        author: { type: "user" },
        target: { type: "broadcast" },
        content: command,
      });
      attempts.push({ command, rejected });
      // Keep later checks deterministic even if an implementation regression
      // accidentally accepts a padded control command and starts a Run.
      for (const run of rejected.json?.runs ?? []) {
        await sse.waitFor((event) => event.type === "run.ended" && event.data.run.id === run.id, 10000);
      }
    }
    for (const { command, rejected } of attempts) {
      assertEqual(rejected.status, 400);
      assertEqual(rejected.json.error.code, "control_command_required", `${JSON.stringify(command)} must be control-only`);
    }
    const after = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    assertEqual(after.status, 200);
    assertEqual(after.json.items.length, before.json.items.length,
      "control commands submitted as Messages must not be persisted");
  });

  await check("p5-c1.4 /new refuses active work, then atomically archives and creates idempotently", async () => {
    const busyMessage = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "keep the old window busy",
    });
    assertEqual(busyMessage.status, 201);
    const busyNew = await httpRequest("POST", `/api/spaces/${space.id}/session/_new`, {
      requestId: "p5-c1-new-busy",
    });
    assertEqual(busyNew.status, 409);
    assertEqual(busyNew.json.error.code, "session_busy");
    await sse.waitFor(
      (event) => event.type === "run.ended" && event.data.run.id === busyMessage.json.runs[0].id,
      10000,
    );

    const invalid = await httpRequest("POST", `/api/spaces/${space.id}/session/_new`, {
      requestId: "p5-c1-new-invalid",
      extra: true,
    });
    assertEqual(invalid.status, 400);
    assertEqual(invalid.json.error.code, "invalid_request");

    const changed = await httpRequest("POST", `/api/spaces/${space.id}/session/_new`, {
      requestId: "p5-c1-new-1",
    });
    assertEqual(changed.status, 200);
    assertEqual(changed.json.archivedSession.id, firstSessionId);
    assertEqual(changed.json.archivedSession.status, "archived");
    assertEqual(changed.json.archivedSession.archiveReason, "new_command");
    assertEqual(changed.json.newSession.status, "active");
    secondSessionId = changed.json.newSession.id;
    assert(secondSessionId !== firstSessionId, "/new must create a distinct SpaceSession");

    const archivedEvent = await sse.waitFor(
      (event) => event.type === "space-session.archived" && event.data.spaceSession.id === firstSessionId,
      5000,
    );
    const createdEvent = await sse.waitFor(
      (event) => event.type === "space-session.created" && event.data.spaceSession.id === secondSessionId,
      5000,
    );
    assert(archivedEvent.seq < createdEvent.seq, "archive event must precede create event");

    const retried = await httpRequest("POST", `/api/spaces/${space.id}/session/_new`, {
      requestId: "p5-c1-new-1",
    });
    assertEqual(retried.status, 200);
    assertEqual(retried.json.archivedSession.id, firstSessionId);
    assertEqual(retried.json.newSession.id, secondSessionId);
  });

  await check("p5-c1.5 active and archived timeline routes are strictly isolated", async () => {
    const posted = await httpRequest("POST", `/api/spaces/${space.id}/messages`, {
      author: { type: "user" },
      target: { type: "broadcast" },
      content: "new window message",
    });
    assertEqual(posted.status, 201);
    assertEqual(posted.json.message.spaceSessionId, secondSessionId);
    const ended = await sse.waitFor(
      (event) => event.type === "run.ended" && event.data.run.id === posted.json.runs[0].id,
      10000,
    );
    assertEqual(ended.data.run.status, "completed");
    assertEqual(ended.data.run.contextGeneration, 1,
      "a new SpaceSession starts a fresh AgentSession generation");

    const active = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    const old = await httpRequest(
      "GET",
      `/api/spaces/${space.id}/sessions/${firstSessionId}/timeline?limit=500`,
    );
    assertEqual(active.status, 200);
    assertEqual(old.status, 200);
    assertTimelineSession(assert, active, secondSessionId, "active timeline");
    assertTimelineSession(assert, old, firstSessionId, "archived timeline");
    const activeIds = itemIds(active);
    const oldIds = itemIds(old);
    assert(activeIds.has(posted.json.message.id), "active timeline should contain the new Message");
    assert(!activeIds.has(firstMessageId), "active timeline must not contain the archived Message");
    assert(oldIds.has(firstMessageId), "archived timeline should retain its Message");
    assert(firstReplyIds.every((id) => oldIds.has(id)), "archived timeline should retain old replies");
    assert(old.json.runs.some((run) => run.spaceSessionId === firstSessionId && run.status === "completed"),
      "archived timeline should retain related Run status");
    assert(!oldIds.has(posted.json.message.id), "archived timeline must not receive new writes");

    const archived = await httpRequest("GET", `/api/spaces/${space.id}/sessions`);
    assertEqual(archived.status, 200);
    assert(archived.json.sessions.some((session) => session.id === firstSessionId));
    assert(!archived.json.sessions.some((session) => session.id === secondSessionId));
  });

  await check("p5-c1.6 /compact uses its dedicated job API and emits no Message", async () => {
    const before = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    const invalid = await httpRequest("POST", `/api/spaces/${space.id}/session/_compact`, {
      requestId: "p5-c1-compact-invalid",
      extra: true,
    });
    assertEqual(invalid.status, 400);
    assertEqual(invalid.json.error.code, "invalid_request");

    const created = await httpRequest("POST", `/api/spaces/${space.id}/session/_compact`, {
      requestId: "p5-c1-compact-1",
    });
    assertEqual(created.status, 202);
    assertEqual(created.json.job.spaceId, space.id);
    assertEqual(created.json.job.spaceSessionId, secondSessionId);
    assertEqual(created.json.job.targets.length, 1);
    const jobId = created.json.job.id;
    await sse.waitFor(
      (event) => event.type === "agent-session.compaction.updated"
        && event.data.jobId === jobId
        && event.data.agentSession.generation === 2,
      5000,
    );
    const detail = await httpRequest(
      "GET",
      `/api/spaces/${space.id}/session/_compact/jobs/${jobId}`,
    );
    assertEqual(detail.status, 200);
    assertEqual(detail.json.job.status, "succeeded");
    assertEqual(detail.json.job.targets[0].fromGeneration, 1);
    assertEqual(detail.json.job.targets[0].toGeneration, 2);
    assertEqual("mode" in detail.json.job.targets[0], false);

    const after = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=500`);
    assertEqual(after.status, 200);
    assertEqual(after.json.items.length, before.json.items.length,
      "compaction must not create Message/Activity timeline records");
  });
}
