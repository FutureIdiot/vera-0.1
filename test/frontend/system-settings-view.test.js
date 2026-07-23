import test from "node:test";
import assert from "node:assert/strict";

import { mountSystemSettingsView } from "../../frontend/src/views/system-settings-view.js";
import { descendants, FakeElement } from "./account-detail-test-support.js";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);
const CHECK_ID = `upd_${"a".repeat(32)}`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("System settings confirms an exact Gateway update and trusts the polled terminal state", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  const confirmations = [];
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    confirm(message) { confirmations.push(message); return true; },
    location: { reload() {} },
  };
  try {
    const requests = [];
    let updateReads = 0;
    const platform = {
      async getGatewayUrl() { return "http://vera.test"; },
      async fetch(url, init) {
        const path = new URL(url).pathname;
        requests.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
        if (path === "/api/settings") return response({ settings: {} });
        if (path === "/api/system/update" && updateReads++ === 0) {
          return response({ update: { supported: true, state: "available", current: { commit: CURRENT }, target: { commit: TARGET }, requestId: CHECK_ID } });
        }
        if (path === "/api/system/update/apply") {
          return response({ update: { supported: true, state: "queued", current: { commit: CURRENT }, target: { commit: TARGET }, requestId: `upd_${"b".repeat(32)}` } }, 202);
        }
        if (path === "/api/system/update") {
          return response({ update: { supported: true, state: "succeeded", current: { commit: TARGET }, target: { commit: TARGET }, requestId: `upd_${"b".repeat(32)}` } });
        }
        throw new Error(`unexpected ${init.method} ${path}`);
      },
    };
    const root = new FakeElement("main");
    const dispose = await mountSystemSettingsView({ root, platform, shell: { setManagementHeader() {} } });
    const apply = descendants(root).find((node) => node.tagName === "BUTTON" && node.textContent === "立即更新");
    assert.equal(apply.disabled, false);
    await apply.listeners.get("click")();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0], new RegExp(TARGET.slice(0, 12), "u"));
    assert.deepEqual(requests.find(([, path]) => path === "/api/system/update/apply"), [
      "POST",
      "/api/system/update/apply",
      { targetCommit: TARGET, ifRequestId: CHECK_ID },
    ]);
    assert.equal(root.textContent.includes("更新成功"), true);
    dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
    globalThis.window = previousWindow;
  }
});

test("System settings renders an unconfigured updater without enabling actions", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, confirm() { return false; }, location: { reload() {} } };
  try {
    const platform = {
      async getGatewayUrl() { return "http://vera.test"; },
      async fetch(url) {
        return new URL(url).pathname === "/api/settings"
          ? response({ settings: {} })
          : response({ update: { supported: false, state: "disabled", current: null, target: null, requestId: null } });
      },
    };
    const root = new FakeElement("main");
    const dispose = await mountSystemSettingsView({ root, platform, shell: { setManagementHeader() {} } });
    const buttons = descendants(root).filter((node) => node.tagName === "BUTTON");
    assert.equal(buttons.find((button) => button.textContent === "检查更新").disabled, true);
    assert.equal(buttons.find((button) => button.textContent === "立即更新").disabled, true);
    assert.equal(root.textContent.includes("没有配置独立更新服务"), true);
    dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
    globalThis.window = previousWindow;
  }
});
