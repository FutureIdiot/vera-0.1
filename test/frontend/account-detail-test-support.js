import assert from "node:assert/strict";

export class FakeElement {
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

  append(...children) { this.children.push(...children); }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this._textContent = "";
    this.children = [...children];
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
}

export function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

export function findSection(root, heading) {
  return descendants(root).find((node) =>
    node.tagName === "SECTION" && node.children.some((child) => child.tagName === "H2" && child.textContent === heading));
}

export function infoRows(section) {
  return descendants(section)
    .filter((node) => node.className === "vera-agent-info-row")
    .map((row) => [row.children[0].textContent, row.children[1].textContent]);
}

export function modelControls(root) {
  const identity = findSection(root, "Account 身份");
  const row = descendants(identity).find((node) =>
    node.className === "vera-agent-info-row" && node.children[0]?.textContent === "模型");
  return {
    select: descendants(row).find((node) => node.tagName === "SELECT"),
    save: descendants(row).find((node) => node.tagName === "BUTTON"),
  };
}

export function fixture(detail, { fetchImpl, spaces = [] } = {}) {
  const root = new FakeElement("main");
  const bootstrap = {
    accounts: [{
      id: "acc_a", name: "Account A", ownerAgentId: "agt_a", activeAgentId: "agt_a",
      presence: "online", accessKeyState: "active", accessKeyVersion: 1,
      workspace: { accountId: "acc_a", hostId: "stale-host", status: "degraded" },
    }],
    agents: [{ id: "agt_a", name: "Agent A" }],
    spaces,
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
    emit(envelope) { subscriber?.(envelope); },
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

export async function withFakeDom(run) {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  globalThis.Node = FakeElement;
  try {
    return await run();
  } finally {
    globalThis.document = previousDocument;
    globalThis.Node = previousNode;
  }
}
