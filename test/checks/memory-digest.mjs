// P5-M2 owner HTTP + SSE black-box checks. The mock adapter intentionally has
// no digestMemory capability, so production wiring must fail safely instead of
// falling back to the chat run interface.

export async function run(ctx) {
  const { check, httpRequest, assertEqual, assert, sse, agent, owningAccount, space } = ctx;
  let requestBody;
  let jobId;

  await check("p5-m2.1 manual digest creates one persisted asynchronous job", async () => {
    const timeline = await httpRequest("GET", `/api/spaces/${space.id}/timeline?limit=50`);
    assertEqual(timeline.status, 200);
    const message = timeline.json.items.find((item) => item.itemType === "message" && item.status === "completed");
    assert(message, "expected one completed Message in the shared verify Space");
    requestBody = {
      accountId: owningAccount.id,
      spaceId: space.id,
      spaceSessionId: timeline.json.spaceSession.id,
      mode: "range",
      fromMessageId: message.id,
      toMessageId: message.id,
    };
    const created = await httpRequest("POST", `/api/agents/${agent.id}/memory/_digest`, requestBody);
    assertEqual(created.status, 202);
    assertEqual(created.json.job.status, "queued");
    assertEqual(created.json.job.range.messageCount, 1);
    jobId = created.json.job.id;

    const failedEvent = await sse.waitFor(
      (event) => event.type === "memory.digest-job.updated"
        && event.data.job.id === jobId
        && event.data.job.status === "failed",
      5000,
    );
    assertEqual(failedEvent.data.job.error.code, "memory_task_unavailable");
    assertEqual(JSON.stringify(failedEvent.data).includes(message.content), false);
  });

  await check("p5-m2.2 duplicate submission is idempotent and job detail is safe", async () => {
    const duplicate = await httpRequest("POST", `/api/agents/${agent.id}/memory/_digest`, requestBody);
    assertEqual(duplicate.status, 202);
    assertEqual(duplicate.json.job.id, jobId);
    const detail = await httpRequest("GET", `/api/agents/${agent.id}/memory/_digest-jobs/${jobId}`);
    assertEqual(detail.status, 200);
    assertEqual(detail.json.job.status, "failed");
    assertEqual(detail.json.job.error.message, "Memory digest task is unavailable.");
    assertEqual("proposals" in detail.json.job, false);
    const unknown = await httpRequest("POST", `/api/agents/${agent.id}/memory/_digest`, {
      ...requestBody,
      sources: [],
    });
    assertEqual(unknown.status, 400);
    assertEqual(unknown.json.error.code, "invalid_request");
  });

  await check("p5-m2.3 retry uses the same job and publishes another safe terminal state", async () => {
    const retried = await httpRequest("POST", `/api/agents/${agent.id}/memory/_digest-jobs/${jobId}/retry`);
    assertEqual(retried.status, 200);
    assertEqual(retried.json.job.id, jobId);
    assertEqual(retried.json.job.status, "queued");
    const failed = await sse.waitFor(
      (event) => event.type === "memory.digest-job.updated"
        && event.data.job.id === jobId
        && event.data.job.status === "failed"
        && event.data.job.attempt === 2,
      5000,
    );
    assertEqual(failed.data.job.error.code, "memory_task_unavailable");
  });
}
