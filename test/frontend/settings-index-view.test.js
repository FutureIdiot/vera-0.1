import test from "node:test";
import assert from "node:assert/strict";

import { mountSettingsIndexView } from "../../frontend/src/views/settings-index-view.js";
import { descendants, FakeElement } from "./account-detail-test-support.js";

test("Settings exposes Account without an Agent directory entry", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  try {
    const root = new FakeElement("main");
    const headers = [];
    const dispose = mountSettingsIndexView({
      root,
      shell: {
        getCurrentSpace() { return { id: "spc_one" }; },
        setManagementHeader(header) { headers.push(header); },
      },
    });

    const links = descendants(root).filter((node) => node.tagName === "A");
    const entries = new Map(links.map((link) => [link.children[0].children[0].textContent, {
      detail: link.children[0].children[1].textContent,
      href: link.href,
    }]));
    assert.deepEqual(entries.get("Account"), {
      detail: "对外身份、模型、Workspace 与接入授权",
      href: "#/settings/accounts",
    });
    assert.equal(entries.has("Agent"), false);
    assert.equal(links.some((link) => link.href === "#/agents"), false);
    assert.equal(entries.get("Account").detail.includes("Agent 系统身份"), false);
    assert.deepEqual(headers.at(-1), {
      title: "Settings",
      backHref: "#/spaces/spc_one",
      backLabel: "返回",
    });
    dispose();
  } finally {
    globalThis.document = previousDocument;
  }
});
