import test from "node:test";
import assert from "node:assert/strict";

import { asHandler } from "../../src/api/http.js";
import { setErrorRecorder } from "../../src/core/status.js";

function responseFixture() {
  const writeHeadCalls = [];
  const endCalls = [];
  let headersSent = false;
  let writableEnded = false;

  return {
    res: {
      get headersSent() { return headersSent; },
      get writableEnded() { return writableEnded; },
      writeHead(status, headers = {}) {
        writeHeadCalls.push({ status, headers });
        headersSent = true;
      },
      end(body = "") {
        endCalls.push(body);
        writableEnded = true;
      },
    },
    writeHeadCalls,
    endCalls,
  };
}

test("asHandler safely ends a started response and records the handler error", async () => {
  const response = responseFixture();
  const errors = [];
  setErrorRecorder((...args) => errors.push(args));

  try {
    const handler = asHandler(async ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      throw Object.assign(new Error("stream failed"), { code: "stream_failed" });
    });

    await handler({ res: response.res });

    assert.deepEqual(response.writeHeadCalls, [
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ]);
    assert.deepEqual(response.endCalls, [""]);
    assert.deepEqual(errors, [["api", "stream_failed", "stream failed"]]);
  } finally {
    setErrorRecorder(null);
  }
});

test("asHandler returns JSON when the response has not started", async () => {
  const response = responseFixture();
  setErrorRecorder(() => {});

  try {
    const handler = asHandler(async () => {
      throw new Error("request failed");
    });

    await handler({ res: response.res });

    assert.deepEqual(response.writeHeadCalls, [
      { status: 500, headers: { "Content-Type": "application/json" } },
    ]);
    assert.deepEqual(JSON.parse(response.endCalls[0]), {
      error: { code: "internal", message: "request failed" },
    });
  } finally {
    setErrorRecorder(null);
  }
});
