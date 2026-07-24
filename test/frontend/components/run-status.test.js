import test from "node:test";
import assert from "node:assert/strict";

import { createRunStatus } from "../../../frontend/src/components/run-status.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = [...children]; }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

function state(accountId, status, detail = "") {
  return {
    type: "agent.state.updated",
    data: {
      agentState: {
        agentId: "agt_owner",
        accountId,
        spaceId: "spc_one",
        status,
        detail,
        lastActiveAt: "2026-07-19T00:00:00.000Z",
      },
    },
  };
}

test("Space run status keeps per-Account states and preserves daemon status text", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const status = createRunStatus();
    const text = status.element.children[0];

    status.handleEvent(state("acc_a", "coding", "review PR"), "spc_one");
    assert.equal(text.textContent, "coding · review PR");
    assert.equal(status.element.hidden, false);

    status.handleEvent(state("acc_b", "reading", "read tests"), "spc_one");
    assert.equal(text.textContent, "2 个 Agent 正在处理…");

    status.handleEvent(state("acc_b", "idle"), "spc_one");
    assert.equal(text.textContent, "coding · review PR");
    assert.equal(status.element.hidden, false);

    status.handleEvent(state("acc_a", "idle"), "spc_one");
    assert.equal(status.element.hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Space run status ignores another Space and reset clears all cached triples", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const status = createRunStatus();
    status.handleEvent({
      ...state("acc_a", "thinking"),
      data: { agentState: { ...state("acc_a", "thinking").data.agentState, spaceId: "spc_other" } },
    }, "spc_one");
    assert.equal(status.element.hidden, true);

    status.handleEvent(state("acc_a", "on_task"), "spc_one");
    assert.equal(status.element.hidden, false);
    status.reset();
    assert.equal(status.element.hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});
