// e. SSE 全链路顺序 + f. seq 单调 / since 重放与 stream.reset。

export async function run(ctx) {
  const { check, sse, assertEqual, assert, connectSse, sleep } = ctx;

  await check("e. SSE run.started -> message.created(streaming) -> delta -> completed -> run.ended order", async () => {
    const runStarted = await sse.waitFor((e) => e.type === "run.started" && e.data.run.id === ctx.firstRunId, 5000);
    const runEnded = await sse.waitFor((e) => e.type === "run.ended" && e.data.run.id === ctx.firstRunId, 10000);
    assertEqual(runEnded.data.run.status, "completed");
    ctx.firstRunStartedSeq = runStarted.seq;

    const related = sse.events.filter((e) => e.seq >= runStarted.seq && e.seq <= runEnded.seq);
    const types = related.map((e) => e.type);

    const idxRunStarted = types.indexOf("run.started");
    const idxMessageCreated = types.indexOf("message.created");
    const idxMessageDelta = types.indexOf("message.delta");
    const idxMessageCompleted = types.indexOf("message.completed");
    const idxRunEnded = types.indexOf("run.ended");

    assert(
      idxRunStarted !== -1 && idxMessageCreated !== -1 && idxMessageDelta !== -1 && idxMessageCompleted !== -1 && idxRunEnded !== -1,
      `missing expected event types in: ${JSON.stringify(types)}`,
    );
    assert(idxRunStarted < idxMessageCreated, "run.started must precede message.created");
    assert(idxMessageCreated < idxMessageDelta, "message.created must precede message.delta");
    assert(idxMessageDelta < idxMessageCompleted, "message.delta must precede message.completed");
    assert(idxMessageCompleted < idxRunEnded, "message.completed must precede run.ended");

    const firstCreated = related.find((e) => e.type === "message.created");
    assertEqual(firstCreated.data.message.status, "streaming", "first bubble should be created as streaming");

    const completedCount = related.filter((e) => e.type === "message.completed").length;
    assert(completedCount >= 2, `expected >=2 message.completed bubbles (mock replies with two paragraphs), got ${completedCount}`);
  });

  await check("f. seq is strictly monotonic across all captured events", async () => {
    for (let i = 1; i < sse.events.length; i += 1) {
      assert(sse.events[i].seq > sse.events[i - 1].seq, `seq must strictly increase at index ${i}`);
    }
  });

  await check("f. reconnect with ?since=<seq> replays only missed events", async () => {
    assert(typeof ctx.firstRunStartedSeq === "number", "firstRunStartedSeq must be captured by the 'e.' check above");
    const expected = sse.events.filter((e) => e.seq > ctx.firstRunStartedSeq).length;

    const replaySse = await connectSse({ port: ctx.port, since: ctx.firstRunStartedSeq });
    await sleep(300);
    assert(replaySse.events.length >= expected, `expected replay to include >= ${expected} events, got ${replaySse.events.length}`);
    assert(replaySse.events.every((e) => e.seq > ctx.firstRunStartedSeq), "replay must only include events after since");
    assert(!replaySse.events.some((e) => e.type === "stream.reset"), "clean replay should not contain stream.reset");
  });
}

// 单独导出：到 verify-space 跑过数轮 run、累计事件远超缓冲大小后才能验证
// "since 超出缓冲 → stream.reset"。放 triggers 段完事后执行。
export async function runSinceBeyondBuffer(ctx) {
  const { check, connectSse, assert, sleep } = ctx;
  await check("f. since beyond ring buffer triggers stream.reset", async () => {
    const resetSse = await connectSse({ port: ctx.port, since: 0 });
    await sleep(300);
    const hasReset = resetSse.events.some((e) => e.type === "stream.reset");
    assert(hasReset, `expected a stream.reset frame, got types: ${JSON.stringify(resetSse.events.map((e) => e.type))}`);
  });
}