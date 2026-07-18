import test from "node:test";
import assert from "node:assert/strict";

import { mountAccountDetailView } from "../../frontend/src/views/account-detail-view.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.disabled = false;
    this.listeners = new Map();
    this._textContent = "";
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._textContent = "";
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

function findSection(root, heading) {
  return descendants(root).find((node) =>
    node.tagName === "SECTION" && node.children.some((child) => child.tagName === "H2" && child.textContent === heading));
}

function infoRows(section) {
  return descendants(section)
    .filter((node) => node.className === "vera-agent-info-row")
    .map((row) => [row.children[0].textContent, row.children[1].textContent]);
}

function fixture(detail, { fetchImpl } = {}) {
  const root = new FakeElement("main");
  const bootstrap = {
    accounts: [{
      id: "acc_a",
      name: "Account A",
      ownerAgentId: "agt_a",
      activeAgentId: "agt_a",
      presence: "online",
      accessKeyState: "active",
      accessKeyVersion: 1,
      workspace: { accountId: "acc_a", hostId: "stale-host", status: "degraded" },
    }],
    agents: [{ id: "agt_a", name: "Agent A" }],
  };
  let subscriber = null;
  const runtime = {
    getBootstrap() { return bootstrap; },
    mergeAccount(account) {
      bootstrap.accounts = bootstrap.accounts.map((item) => item.id === account.id ? account : item);
    },
    subscribe(next) {
      subscriber = next;
      return () => { subscriber = null; };
    },
  };
  const platform = {
    async getGatewayUrl() { return "http://vera.test"; },
    async fetch(url, init) {
      if (fetchImpl) return fetchImpl(url, init);
      assert.equal(url, "http://vera.test/api/accounts/acc_a");
      assert.equal(init.method, "GET");
      return new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { root, runtime, platform };
}

test("Account detail renders only the frozen recentLogins fields and nested Workspace summary", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  try {
    const createdAt = "2026-07-18T01:02:03.000Z";
    const detail = {
      account: {
        id: "acc_a",
        name: "Account A",
        ownerAgentId: "agt_a",
        activeAgentId: "agt_a",
        presence: "online",
        accessKeyState: "active",
        accessKeyVersion: 1,
        workspace: { accountId: "acc_a", hostId: "host-a", status: "ready", lastValidatedAt: createdAt },
      },
      ownerAgent: { id: "agt_a", name: "Agent A" },
      activeAgent: { id: "agt_a", name: "Agent A" },
      recentLogins: [{
        id: "aud_a",
        accountId: "acc_a",
        agentId: "agt_a",
        event: "login",
        result: "rejected",
        reasonCode: "account_busy",
        createdAt,
        status: "must-not-render",
        message: "free text must not render",
        at: "legacy-time-must-not-render",
      }],
      workspace: { hostId: "legacy-host-must-not-render", status: "legacy" },
      loginAudit: [{ event: "logout", result: "succeeded", agentId: "agt_legacy", createdAt }],
    };
    const { root, runtime, platform } = fixture(detail);
    const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });

    const workspaceRows = new Map(infoRows(findSection(root, "Workspace")));
    assert.equal(workspaceRows.get("宿主"), "host-a");
    assert.equal(root.textContent.includes("legacy-host-must-not-render"), false);

    const audit = findSection(root, "最近登录");
    const cards = descendants(audit).filter((node) => node.className === "vera-management-card");
    assert.equal(cards.length, 1);
    assert.deepEqual(infoRows(cards[0]), [
      ["事件", "login"],
      ["结果", "rejected"],
      ["原因", "account_busy"],
      ["Agent", "Agent A"],
      ["时间", new Date(createdAt).toLocaleString()],
    ]);
    for (const unsafe of ["must-not-render", "free text must not render", "legacy-time-must-not-render", "logout", "agt_legacy"]) {
      assert.equal(audit.textContent.includes(unsafe), false, `${unsafe} should not render`);
    }
    dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
});

test("Account detail shows a safe empty state when recentLogins is absent", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  try {
    const detail = {
      account: {
        id: "acc_a",
        name: "Account A",
        ownerAgentId: "agt_a",
        activeAgentId: null,
        presence: "offline",
        accessKeyState: "revoked",
        accessKeyVersion: 2,
        workspace: null,
      },
      ownerAgent: { id: "agt_a", name: "Agent A" },
      activeAgent: null,
      loginAudit: [{ event: "login", result: "succeeded", agentId: "agt_a", createdAt: "2026-07-18T01:02:03.000Z" }],
    };
    const { root, runtime, platform } = fixture(detail);
    const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });

    const audit = findSection(root, "最近登录");
    assert.equal(audit.textContent.includes("还没有登录记录。"), true);
    assert.equal(audit.textContent.includes("succeeded"), false);
    assert.equal(descendants(audit).some((node) => node.className === "vera-management-card"), false);
    dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
});

test("rotating a key refreshes the audit list without hiding the one-time key", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  try {
    const baseAccount = {
      id: "acc_a",
      name: "Account A",
      ownerAgentId: "agt_a",
      activeAgentId: "agt_a",
      presence: "online",
      accessKeyState: "active",
      accessKeyVersion: 1,
      workspace: null,
    };
    let detailReads = 0;
    const fetchImpl = async (url, init) => {
      if (init.method === "POST") {
        assert.equal(url, "http://vera.test/api/accounts/acc_a/access-key/rotate");
        return new Response(JSON.stringify({
          account: { ...baseAccount, activeAgentId: null, presence: "offline", accessKeyVersion: 2 },
          accessKey: "vak_once",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      detailReads += 1;
      return new Response(JSON.stringify({
        account: detailReads === 1 ? baseAccount : {
          ...baseAccount, activeAgentId: null, presence: "offline", accessKeyVersion: 2,
        },
        ownerAgent: { id: "agt_a", name: "Agent A" },
        activeAgent: detailReads === 1 ? { id: "agt_a", name: "Agent A" } : null,
        recentLogins: detailReads === 1 ? [] : [{
          id: "ala_rotation",
          accountId: "acc_a",
          agentId: "agt_a",
          event: "session_revoked",
          result: "succeeded",
          reasonCode: "access_key_rotated",
          createdAt: "2026-07-18T01:02:03.000Z",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const { root, runtime, platform } = fixture({ account: baseAccount }, { fetchImpl });
    const dispose = await mountAccountDetailView({ root, runtime, platform, accountId: "acc_a" });
    const rotate = descendants(root).find((node) => node.textContent === "生成 / 轮换 Key");
    await rotate.listeners.get("click")();

    const audit = findSection(root, "最近登录");
    assert.equal(audit.textContent.includes("session_revoked"), true);
    assert.equal(audit.textContent.includes("access_key_rotated"), true);
    assert.equal(root.textContent.includes("一次性接入 Key：vak_once"), true);
    assert.equal(detailReads, 2);
    dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
});
