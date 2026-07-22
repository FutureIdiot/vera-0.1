import test from "node:test";
import assert from "node:assert/strict";

import { mountAccountDetailView } from "../../frontend/src/views/account-detail-view.js";
import {
  descendants,
  findSection,
  fixture,
  infoRows,
  modelControls,
  withFakeDom,
} from "./account-detail-test-support.js";

function account(overrides = {}) {
  return {
    id: "acc_a",
    name: "Account A",
    ownerAgentId: "agt_a",
    activeAgentId: "agt_a",
    model: "model-a",
    modelVersion: 3,
    presence: "online",
    accessKeyState: "active",
    accessKeyVersion: 1,
    workspace: null,
    ...overrides,
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Account detail saves its independent model with CAS and merges the response", () => withFakeDom(async () => {
  const initial = account();
  const detail = {
    account: initial,
    ownerAgent: { id: "agt_a", name: "Agent A" },
    activeAgent: { id: "agt_a", name: "Agent A" },
    modelOptions: ["model-a", "model-b"],
    recentLogins: [],
  };
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push([url, init.method, init.body]);
    return init.method === "PUT"
      ? json({ account: { ...initial, model: "model-b", modelVersion: 4 } })
      : json(detail);
  };
  const { root, runtime, platform } = fixture(detail, { fetchImpl });
  const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });

  const identity = findSection(root, "Account 身份");
  const ownerLink = descendants(identity).find((node) => node.tagName === "A");
  assert.deepEqual([ownerLink.textContent, ownerLink.href], ["Agent A", "#/agents/agt_a"]);
  assert.equal(infoRows(identity).some(([label]) => label === "当前 Agent"), false);
  const controls = modelControls(root);
  assert.deepEqual(controls.select.children.map((option) => option.value), ["model-a", "model-b"]);
  assert.equal(controls.select.value, "model-a");
  assert.equal(controls.save.disabled, true);

  controls.select.value = "model-b";
  controls.select.listeners.get("change")();
  assert.equal(controls.save.disabled, false);
  await controls.save.listeners.get("click")();

  assert.deepEqual(requests, [
    ["http://vera.test/api/accounts/acc_a", "GET", undefined],
    ["http://vera.test/api/accounts/acc_a/model", "PUT", JSON.stringify({ model: "model-b", ifVersion: 3 })],
  ]);
  assert.deepEqual(
    [runtime.getBootstrap().accounts[0].model, runtime.getBootstrap().accounts[0].modelVersion],
    ["model-b", 4],
  );
  assert.equal(root.textContent.includes("聊天上下文已轮换"), true);
  assert.equal(descendants(root).some((node) => node.dataset.tone === "success"), true);
  dispose();
}));

test("Account detail preserves an unavailable model and rolls back a failed save", () => withFakeDom(async () => {
  const initial = account({ model: "retired-model", modelVersion: 7 });
  const detail = {
    account: initial,
    ownerAgent: { id: "agt_a", name: "Agent A" },
    activeAgent: { id: "agt_a", name: "Agent A" },
    modelOptions: ["model-a"],
    recentLogins: [],
  };
  const fetchImpl = async (_url, init) => {
    if (init.method !== "PUT") return json(detail);
    assert.deepEqual(JSON.parse(init.body), { model: "model-a", ifVersion: 7 });
    return json({ error: { code: "version_conflict", message: "模型版本已变化，请重试" } }, 409);
  };
  const { root, runtime, platform } = fixture(detail, { fetchImpl });
  const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });
  const controls = modelControls(root);

  assert.deepEqual(controls.select.children.map((option) => [option.value, option.textContent, option.disabled]), [
    ["retired-model", "retired-model（当前不可用）", true],
    ["model-a", "model-a", false],
  ]);
  controls.select.value = "model-a";
  controls.select.listeners.get("change")();
  await controls.save.listeners.get("click")();

  assert.equal(controls.select.value, "retired-model");
  assert.equal(controls.save.disabled, true);
  assert.equal(runtime.getBootstrap().accounts[0].model, "retired-model");
  assert.equal(root.textContent.includes("模型版本已变化，请重试"), true);
  assert.equal(descendants(root).some((node) => node.dataset.tone === "danger"), true);
  dispose();
}));

test("Account detail disables model writes without an owner or candidates", () => withFakeDom(async () => {
  const noOwner = {
    account: account({ ownerAgentId: null }),
    ownerAgent: null,
    activeAgent: null,
    modelOptions: ["model-a", "model-b"],
    recentLogins: [],
  };
  const first = fixture(noOwner);
  const disposeFirst = await mountAccountDetailView({
    root: first.root, runtime: first.runtime, platform: first.platform, accountId: "acc_a",
  });
  assert.equal(modelControls(first.root).select.disabled, true);
  assert.equal(modelControls(first.root).save.disabled, true);
  disposeFirst();

  const noCandidates = {
    account: account(),
    ownerAgent: { id: "agt_a", name: "Agent A" },
    activeAgent: null,
    modelOptions: [],
    recentLogins: [],
  };
  const second = fixture(noCandidates);
  const disposeSecond = await mountAccountDetailView({
    root: second.root, runtime: second.runtime, platform: second.platform, accountId: "acc_a",
  });
  const controls = modelControls(second.root);
  assert.equal(controls.select.disabled, true);
  assert.equal(controls.save.disabled, true);
  assert.deepEqual(controls.select.children.map((option) => option.value), ["model-a"]);
  assert.equal(controls.select.children[0].disabled, true);
  disposeSecond();
}));

test("presence updates reload account detail and refresh model options", () => withFakeDom(async () => {
  const initial = account();
  let reads = 0;
  const fetchImpl = async (_url, init) => {
    assert.equal(init.method, "GET");
    reads += 1;
    return json({
      account: initial,
      ownerAgent: { id: "agt_a", name: "Agent A" },
      activeAgent: { id: "agt_a", name: "Agent A" },
      modelOptions: reads === 1 ? ["model-a"] : ["model-a", "model-b"],
      recentLogins: [],
    });
  };
  const { root, runtime, platform } = fixture({}, { fetchImpl });
  const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });
  assert.deepEqual(modelControls(root).select.children.map((option) => option.value), ["model-a"]);

  runtime.emit({ type: "account.presence.updated", data: { accountId: "acc_a", presence: "online" } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reads, 2);
  assert.deepEqual(modelControls(root).select.children.map((option) => option.value), ["model-a", "model-b"]);
  dispose();
}));
