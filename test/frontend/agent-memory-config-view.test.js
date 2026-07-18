import test from "node:test";
import assert from "node:assert/strict";

import { mountAgentMemoryConfigView } from "../../frontend/src/views/agent-memory-config-view.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.listeners = new Map();
    this._textContent = "";
    this.value = "";
    this.type = "";
    this.disabled = false;
    this.hidden = false;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this._textContent = ""; this.children = [...children]; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function control(root, name) {
  const found = descendants(root).find((node) => node.dataset.control === name);
  assert.ok(found, `control ${name} should exist`);
  return found;
}

async function emit(node, type) {
  const listener = node.listeners.get(type);
  assert.ok(listener, `${type} listener should exist`);
  await listener({ preventDefault() {} });
}

const provider = { providerId: "vera.markdown", placement: { runtime: "gateway" }, config: {} };

function taskConfig(kind) {
  return kind === "digest"
    ? { executorAgentId: null, modelMode: "inherit", model: null, trigger: { mode: "manual" } }
    : { executorAgentId: null, modelMode: "inherit", model: null, schedule: { mode: "manual" } };
}

function baseConfig(overrides = {}) {
  return {
    agentId: "agt_owner",
    provider,
    digest: taskConfig("digest"),
    dream: taskConfig("dream"),
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  const executor = {
    agentId: "agt_owner",
    name: "Owner",
    runtimeRevision: "sha256:runtime",
    availability: "available",
    models: [{ model: "model-a", verificationId: "verify-a", isDefault: true }],
  };
  return {
    providers: [{ providerId: "vera.markdown", name: "Vera Markdown", source: "built-in", availability: "available" }],
    tasks: { digest: { executors: [executor] }, dream: { executors: [executor] } },
    ...overrides,
  };
}

function pendingSpace(suffix) {
  return {
    accountId: `acc_${suffix}`,
    spaceId: `spc_${suffix}`,
    spaceSessionId: `sps_${suffix}`,
    messageCount: 3,
    charCount: 90,
    estimatedTokens: { estimator: "vera-utf8-v1", value: 30 },
    currentContext: {
      agentSessionId: `ags_${suffix}`,
      generation: 1,
      estimatedInputTokens: 500,
      effectiveLimitTokens: 1000,
      pressureRatio: 0.5,
      measurement: "estimated",
    },
  };
}

function pendingKey(item) {
  return JSON.stringify([item.accountId, item.spaceId, item.spaceSessionId]);
}

function baseStatus(spaces = []) {
  return {
    provider: {
      providerId: "vera.markdown",
      placement: { runtime: "gateway" },
      state: "available",
      capabilities: {},
      location: { runtime: "gateway", agentPath: "agt_owner" },
    },
    longTerm: {
      activeCount: 4,
      archivedCount: 2,
      logicalBytes: 2048,
      estimatedTokens: { estimator: "vera-utf8-v1", value: 111 },
    },
    pendingContext: {
      messageCount: spaces.reduce((sum, item) => sum + item.messageCount, 0),
      charCount: spaces.reduce((sum, item) => sum + item.charCount, 0),
      estimatedTokens: { estimator: "vera-utf8-v1", value: spaces.length * 30 },
      spaces,
    },
    digest: { status: "idle" },
    dream: { status: "idle" },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createFixture({ config = baseConfig(), options = baseOptions(), getStatus = () => baseStatus(), onRequest } = {}) {
  const root = new FakeElement("main");
  let subscriber = null;
  const requests = [];
  const runtime = {
    getBootstrap() { return { agents: [{ id: "agt_owner", name: "Owner" }] }; },
    subscribe(listener) { subscriber = listener; return () => { subscriber = null; }; },
  };
  const platform = {
    async getGatewayUrl() { return "http://vera.test"; },
    async fetch(url, init) {
      const path = new URL(url).pathname;
      const request = { method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined };
      requests.push(request);
      if (onRequest) {
        const response = await onRequest(request);
        if (response) return response;
      }
      if (request.method === "GET" && path.endsWith("/_config")) return jsonResponse({ config, version: "version-1" });
      if (request.method === "GET" && path.endsWith("/_options")) return jsonResponse(options);
      if (request.method === "GET" && path.endsWith("/_status")) return jsonResponse(getStatus());
      throw new Error(`unexpected request: ${request.method} ${path}`);
    },
  };
  return { root, runtime, platform, requests, send: (envelope) => subscriber?.(envelope) };
}

async function withDom(fn) {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  try { await fn(); }
  finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
}

test("Memory config PATCH sends a complete slice with CAS and adopts each returned version", async () => {
  await withDom(async () => {
    let serverConfig = baseConfig();
    let serverVersion = "version-1";
    const patches = [];
    const fixture = createFixture({
      getStatus: () => baseStatus([pendingSpace("one")]),
      onRequest(request) {
        if (request.method !== "PATCH") return null;
        patches.push(request.body);
        const kind = request.body.digest ? "digest" : "dream";
        serverConfig = { ...serverConfig, [kind]: request.body[kind] };
        serverVersion = kind === "digest" ? "version-2" : "version-3";
        return jsonResponse({ config: serverConfig, version: serverVersion });
      },
    });
    const dispose = await mountAgentMemoryConfigView({ ...fixture, agentId: "agt_owner" });
    assert.match(fixture.root.textContent, /111 tokens/u);
    assert.match(fixture.root.textContent, /50%/u);

    const digestModelMode = control(fixture.root, "digest-model-mode");
    digestModelMode.value = "fixed";
    await emit(digestModelMode, "change");
    const digestModel = control(fixture.root, "digest-model");
    digestModel.value = "model-a";
    await emit(digestModel, "change");
    const digestMode = control(fixture.root, "digest-timing-mode");
    digestMode.value = "scheduled";
    await emit(digestMode, "change");
    const cron = control(fixture.root, "digest-cron");
    cron.value = "5 4 * * *";
    await emit(cron, "change");
    const digestTimezone = control(fixture.root, "digest-timezone");
    digestTimezone.value = "Asia/Tokyo";
    await emit(digestTimezone, "change");
    await emit(control(fixture.root, "digest-save"), "click");

    assert.deepEqual(patches[0], {
      digest: {
        executorAgentId: null,
        modelMode: "fixed",
        model: "model-a",
        trigger: { mode: "scheduled", cron: "5 4 * * *", timezone: "Asia/Tokyo" },
      },
      ifMatch: "version-1",
    });

    const dreamMode = control(fixture.root, "dream-timing-mode");
    dreamMode.value = "weekly";
    await emit(dreamMode, "change");
    const dreamTimezone = control(fixture.root, "dream-timezone");
    dreamTimezone.value = "UTC";
    await emit(dreamTimezone, "change");
    const weekday = control(fixture.root, "dream-weekday");
    weekday.value = "7";
    await emit(weekday, "change");
    const time = control(fixture.root, "dream-time");
    time.value = "02:30";
    await emit(time, "change");
    await emit(control(fixture.root, "dream-save"), "click");
    assert.deepEqual(patches[1], {
      dream: {
        executorAgentId: null,
        modelMode: "inherit",
        model: null,
        schedule: { mode: "weekly", timezone: "UTC", weekday: 7, time: "02:30" },
      },
      ifMatch: "version-2",
    });
    dispose();
  });
});

test("invalid saved task selections remain visible and block new jobs without fallback", async () => {
  await withDom(async () => {
    const invalidDigest = {
      executorAgentId: "agt_missing",
      modelMode: "fixed",
      model: "retired-model",
      trigger: { mode: "manual" },
    };
    const status = baseStatus([pendingSpace("one")]);
    status.dream = { status: "running", currentJobId: "drm_active" };
    const fixture = createFixture({
      config: baseConfig({ digest: invalidDigest }),
      getStatus: () => status,
      onRequest(request) {
        if (request.method === "POST" && request.path.endsWith("/_dream")) {
          return jsonResponse({ job: { id: "drm_active", status: "running" }, coalesced: true }, 202);
        }
        return null;
      },
    });
    const dispose = await mountAgentMemoryConfigView({ ...fixture, agentId: "agt_owner" });

    assert.match(fixture.root.textContent, /agt_missing/u);
    assert.match(fixture.root.textContent, /retired-model/u);
    assert.match(fixture.root.textContent, /不会自动改投/u);
    assert.equal(control(fixture.root, "digest-run").disabled, true);
    assert.equal(control(fixture.root, "dream-run").disabled, false);
    await emit(control(fixture.root, "digest-run"), "click");
    await emit(control(fixture.root, "dream-run"), "click");
    assert.deepEqual(fixture.requests.filter((request) => request.method === "POST").map((request) => request.path), [
      "/api/agents/agt_owner/memory/_dream",
    ]);
    assert.match(fixture.root.textContent, /本次请求已合并/u);
    dispose();
  });
});

test("manual Digest handles zero, one, and multiple pending windows with an exact request body", async (t) => {
  for (const item of [
    { name: "zero", spaces: [], selected: null },
    { name: "one", spaces: [pendingSpace("one")], selected: 0 },
    { name: "multiple", spaces: [pendingSpace("one"), pendingSpace("two")], selected: 1 },
  ]) {
    await t.test(item.name, async () => withDom(async () => {
      let digestBody = null;
      const fixture = createFixture({
        getStatus: () => baseStatus(item.spaces),
        onRequest(request) {
          if (request.method === "POST" && request.path.endsWith("/_digest")) {
            digestBody = request.body;
            return jsonResponse({ job: { id: "job_one", status: "queued" } }, 202);
          }
          return null;
        },
      });
      const dispose = await mountAgentMemoryConfigView({ ...fixture, agentId: "agt_owner" });
      let button = control(fixture.root, "digest-run");
      const picker = control(fixture.root, "digest-pending-space");
      if (item.selected === null) {
        assert.equal(picker.disabled, true);
        assert.equal(button.disabled, true);
      } else {
        if (item.spaces.length > 1) {
          assert.equal(picker.value, "");
          assert.equal(button.disabled, true);
          picker.value = pendingKey(item.spaces[item.selected]);
          await emit(picker, "change");
          button = control(fixture.root, "digest-run");
        }
        assert.equal(button.disabled, false);
        await emit(button, "click");
        const selected = item.spaces[item.selected];
        assert.deepEqual(digestBody, {
          accountId: selected.accountId,
          spaceId: selected.spaceId,
          spaceSessionId: selected.spaceSessionId,
          mode: "incremental",
        });
      }
      dispose();
    }));
  }
});

test("matching Digest and Dream SSE events refresh status only for the mounted Agent", async () => {
  await withDom(async () => {
    let statusCalls = 0;
    const fixture = createFixture({
      getStatus() {
        statusCalls += 1;
        return baseStatus(Array.from({ length: statusCalls }, (_, index) => pendingSpace(String(index + 1))));
      },
    });
    const dispose = await mountAgentMemoryConfigView({ ...fixture, agentId: "agt_owner" });
    assert.equal(statusCalls, 1);
    fixture.send({ type: "memory.digest-job.updated", data: { job: { agentId: "agt_other" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusCalls, 1);
    fixture.send({ type: "memory.digest-job.updated", data: { job: { agentId: "agt_owner" } } });
    await new Promise((resolve) => setImmediate(resolve));
    fixture.send({ type: "memory.dream-job.updated", data: { agentId: "agt_owner" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statusCalls, 3);
    assert.match(fixture.root.textContent, /9 条消息/u);
    dispose();
  });
});

test("unknown long-term totals stay unavailable and a failed initial load can retry", async () => {
  await withDom(async () => {
    let failConfig = true;
    const status = baseStatus();
    status.longTerm = {
      activeCount: null,
      archivedCount: null,
      logicalBytes: null,
      estimatedTokens: { estimator: "vera-utf8-v1", value: null },
    };
    const fixture = createFixture({
      getStatus: () => status,
      onRequest(request) {
        if (failConfig && request.method === "GET" && request.path.endsWith("/_config")) {
          failConfig = false;
          throw new Error("config offline");
        }
        return null;
      },
    });
    const dispose = await mountAgentMemoryConfigView({ ...fixture, agentId: "agt_owner" });
    assert.match(fixture.root.textContent, /Memory 配置读取失败：config offline/u);
    assert.match(fixture.root.textContent, /长期记忆管理/u);
    const retry = descendants(fixture.root).find((node) => node.tagName === "BUTTON" && node.textContent === "重试");
    await emit(retry, "click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(fixture.root.textContent, /长期记忆不可用 · 不可用/u);
    assert.doesNotMatch(fixture.root.textContent, /0 条活跃/u);
    dispose();
  });
});
