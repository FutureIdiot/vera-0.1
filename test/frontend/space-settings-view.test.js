import test from "node:test";
import assert from "node:assert/strict";

import { mountSpaceSettingsView } from "../../frontend/src/views/space-settings-view.js";
import { descendants, FakeElement } from "./account-detail-test-support.js";

class SpaceElement extends FakeElement {
  constructor(tagName) {
    super(tagName);
    this.attributes = {};
    this.checked = false;
    this.hidden = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
}

function createFixture(space, { onPatch } = {}) {
  const bootstrap = {
    seq: 1,
    accounts: [
      { id: "acc_a", name: "Alpha", ownerAgentId: "agt_a", activeAgentId: "agt_a" },
      { id: "acc_b", name: "Beta", ownerAgentId: "agt_b", activeAgentId: "agt_b" },
      { id: "acc_c", name: "Not in this Space" },
    ],
    agents: [
      { id: "agt_a", name: "Agent Alpha" },
      { id: "agt_b", name: "Agent Beta" },
    ],
    spaces: [space],
  };
  const root = new SpaceElement("main");
  const runtime = {
    getBootstrap() { return bootstrap; },
    subscribe() { return () => {}; },
  };
  const platform = {
    async getGatewayUrl() { return "http://vera.test"; },
    async fetch(url, init) {
      assert.equal(url, `http://vera.test/api/spaces/${space.id}`);
      assert.equal(init.method, "PATCH");
      const body = JSON.parse(init.body);
      onPatch?.(body);
      return new Response(JSON.stringify({ space: { ...space, ...body } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return {
    root,
    runtime,
    platform,
    shell: { setManagementHeader() {}, setSpace() {} },
  };
}

async function withFakeDom(run) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousSetTimeout = globalThis.setTimeout;
  globalThis.document = { createElement: (tagName) => new SpaceElement(tagName) };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, confirm() { return true; } };
  globalThis.setTimeout = () => 0;
  try {
    return await run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.setTimeout = previousSetTimeout;
  }
}

test("Direct Space settings omit the fixed participant list", async () => {
  await withFakeDom(async () => {
    const space = {
      id: "spc_direct",
      name: "Direct",
      groupId: null,
      seats: [{ accountId: "acc_a", responseMode: "default" }],
      notifications: { mode: "accountMessages", includeActivityErrors: true },
    };
    const fixture = createFixture(space);
    const dispose = mountSpaceSettingsView({ ...fixture, spaceId: space.id });

    assert.equal(descendants(fixture.root).some((node) => node.className === "vera-space-participant"), false);
    assert.equal(fixture.root.textContent.includes("参与 Account"), false);
    assert.equal(fixture.root.textContent.includes("Not in this Space"), false);
    const permissionRows = descendants(fixture.root)
      .filter((node) => node.className === "vera-settings-row vera-space-permission-row");
    assert.equal(permissionRows.length, 1);
    assert.equal(permissionRows[0].children[0].textContent, "Agent Alpha");
    assert.equal(permissionRows[0].children[1].value, "ask");
    dispose();
  });
});

test("Group Space settings expose focused response sources and preserve hidden block rules", async () => {
  await withFakeDom(async () => {
    const space = {
      id: "spc_group",
      name: "Group",
      groupId: "grp_one",
      seats: [
        {
          accountId: "acc_a",
          responseMode: "default",
          approvalPolicy: "approve",
          respondTo: ["user", "acc_b"],
          blockAccountIds: ["acc_b"],
        },
        { accountId: "acc_b", responseMode: "mentioned", approvalPolicy: "ask" },
      ],
      notifications: { mode: "accountMessages", includeActivityErrors: true },
    };
    let patched = null;
    const fixture = createFixture(space, { onPatch(body) { patched = body; } });
    const dispose = mountSpaceSettingsView({ ...fixture, spaceId: space.id });

    const rows = descendants(fixture.root).filter((node) => node.className === "vera-space-participant");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.children[0].textContent), ["Alpha", "Beta"]);
    assert.equal(fixture.root.textContent.includes("Not in this Space"), false);
    assert.equal(fixture.root.textContent.includes("响应 Beta"), false);
    assert.equal(fixture.root.textContent.includes("屏蔽 Beta"), false);

    const sourceField = rows[0].children[2];
    assert.equal(sourceField.hidden, true);
    assert.equal(sourceField.textContent, "响应来源UserBeta");
    rows[0].children[1].value = "focused";
    rows[0].children[1].listeners.get("change")();
    assert.equal(sourceField.hidden, false);
    const sourceInputs = descendants(sourceField).filter((node) => node.tagName === "INPUT");
    assert.deepEqual(sourceInputs.map((input) => [input.value, input.checked]), [
      ["user", true],
      ["acc_b", true],
    ]);
    sourceInputs[1].checked = false;
    const permissionRows = descendants(fixture.root)
      .filter((node) => node.className === "vera-settings-row vera-space-permission-row");
    assert.deepEqual(permissionRows.map((row) => [
      row.children[0].textContent,
      row.children[1].value,
    ]), [
      ["Agent Alpha", "approve"],
      ["Agent Beta", "ask"],
    ]);
    permissionRows[1].children[1].value = "approve";
    const form = descendants(fixture.root).find((node) => node.className === "vera-space-form");
    await form.listeners.get("submit")({ preventDefault() {} });
    assert.deepEqual(patched.seats, [
      {
        accountId: "acc_a",
        responseMode: "focused",
        approvalPolicy: "approve",
        respondTo: ["user"],
        blockAccountIds: ["acc_b"],
      },
      { accountId: "acc_b", responseMode: "mentioned", approvalPolicy: "approve" },
    ]);
    dispose();
  });
});
