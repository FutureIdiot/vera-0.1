// P5-M4 per-Agent Data/Memory control surface and Dream safe-job checks.

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse, agent } = ctx;
  let dreamJobId;

  await check("p5-m4.1 Memory config, options, and status are Agent-scoped safe projections", async () => {
    const config = await httpRequest("GET", `/api/agents/${agent.id}/memory/_config`);
    assertEqual(config.status, 200);
    assertEqual(config.json.config.agentId, agent.id);
    assertEqual(config.json.config.provider.providerId, "vera.markdown");
    assert(/^sha256:[a-f0-9]{64}$/.test(config.json.version), "expected opaque config version");

    const options = await httpRequest("GET", `/api/agents/${agent.id}/memory/_options`);
    assertEqual(options.status, 200);
    assertEqual(options.json.providers[0].providerId, "vera.markdown");
    assertEqual(options.json.tasks.digest.executors.some((item) => item.agentId === agent.id), true);
    assertEqual(JSON.stringify(options.json).includes("connection"), false);

    const status = await httpRequest("GET", `/api/agents/${agent.id}/memory/_status`);
    assertEqual(status.status, 200);
    assertEqual(status.json.provider.state, "available");
    assertEqual("hooks" in status.json, false);
    assertEqual("activeCount" in status.json.longTerm, true);
    assertEqual("archivedCount" in status.json.longTerm, true);
    assertEqual("logicalBytes" in status.json.longTerm, true);
    assertEqual(status.json.longTerm.estimatedTokens.estimator, "vera-utf8-v1");
    assertEqual("messageCount" in status.json.pendingContext, true);
    assertEqual(status.json.pendingContext.estimatedTokens.estimator, "vera-utf8-v1");
  });

  await check("p5-m4.2 Hook bindings use optimistic versions outside Memory status", async () => {
    const hooks = await httpRequest("GET", `/api/agents/${agent.id}/unit-bindings?kind=hook`);
    assertEqual(hooks.status, 200);
    assertEqual(hooks.json.bindings.length, 2);
    const recall = hooks.json.bindings.find((item) => item.unitId === "vera.memory.recall");
    const changed = await httpRequest("PATCH", `/api/agents/${agent.id}/unit-bindings/${recall.unitId}`, {
      enabled: false,
      ifMatch: recall.version,
    });
    assertEqual(changed.status, 200);
    assertEqual(changed.json.binding.enabled, false);
    const stale = await httpRequest("PATCH", `/api/agents/${agent.id}/unit-bindings/${recall.unitId}`, {
      enabled: true,
      ifMatch: recall.version,
    });
    assertEqual(stale.status, 409);
    const refreshed = await httpRequest("GET", `/api/agents/${agent.id}/unit-bindings?kind=hook`);
    assertEqual(refreshed.json.bindings.find((item) => item.unitId === "vera.memory.recall").enabled, false);
  });

  await check("p5-m4.3 Dream is asynchronous, idempotent, and fails without an unverified fallback", async () => {
    const created = await httpRequest("POST", `/api/agents/${agent.id}/memory/_dream`, { requestId: "verify-dream-one" });
    assertEqual(created.status, 202);
    assertEqual(created.json.coalesced, false);
    dreamJobId = created.json.job.id;
    const failed = await sse.waitFor(
      (event) => event.type === "memory.dream-job.updated"
        && event.data.job.id === dreamJobId
        && event.data.job.status === "failed",
      5000,
    );
    assertEqual(failed.data.job.error.code, "memory_task_unavailable");
    assertEqual(JSON.stringify(failed.data).includes("memoryTaskSnapshot"), false);

    const duplicate = await httpRequest("POST", `/api/agents/${agent.id}/memory/_dream`, { requestId: "verify-dream-one" });
    assertEqual(duplicate.status, 202);
    assertEqual(duplicate.json.job.id, dreamJobId);
    const detail = await httpRequest("GET", `/api/agents/${agent.id}/memory/_dream/jobs/${dreamJobId}`);
    assertEqual(detail.status, 200);
    assertEqual(detail.json.job.error.code, "memory_task_unavailable");
    assertEqual("proposals" in detail.json.job, false);
  });
}
