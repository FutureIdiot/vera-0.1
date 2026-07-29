import test from "node:test";
import assert from "node:assert/strict";

import { createRunProgress } from "../../../frontend/src/components/run-progress.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.href = "";
    this.title = "";
    this.listeners = new Map();
    this.parent = null;
    this._textContent = "";
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value);
    if (value === "") this.children = [];
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }

  removeChild(child) {
    this.children = this.children.filter((item) => item !== child);
    child.parent = null;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    this.parent?.removeChild(this);
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes[name] = String(value); }

  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (!className) return null;
    for (const child of this.children) {
      if (child.className.split(" ").includes(className)) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function run(id, accountId = "acc_gemini") {
  return {
    id,
    role: "main",
    parentRunId: null,
    agentId: `agt_${accountId}`,
    accountId,
    accountNameSnapshot: accountId === "acc_gemini" ? "Gemini" : "Codex",
    spaceId: "spc_group",
    spaceSessionId: "sps_group",
    effectiveModel: accountId === "acc_gemini" ? "gemini-flash" : "gpt-test",
    status: "running",
    backgroundEligibleAt: "2026-07-29T00:00:10.000Z",
    backgroundedAt: null,
    createdAt: "2026-07-29T00:00:00.000Z",
  };
}

function state(accountId, status, detail = "") {
  return {
    type: "agent.state.updated",
    data: {
      agentState: {
        agentId: `agt_${accountId}`,
        accountId,
        spaceId: "spc_group",
        status,
        detail,
        lastActiveAt: "2026-07-29T00:00:01.000Z",
      },
    },
  };
}

test("group Chat gives each running Account a status placeholder and reveals background only after eligibility", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  const backgrounded = [];
  let clock = Date.parse("2026-07-29T00:00:09.000Z");
  const timers = [];
  try {
    const container = new FakeElement("div");
    const progress = createRunProgress({
      onBackground: async (runId) => { backgrounded.push(runId); },
      now: () => clock,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => {},
    });
    progress.setContext({ spaceId: "spc_group", spaceSessionId: "sps_group", isGroupChat: true });
    progress.attach(container);
    progress.handleEvent({ type: "run.started", data: { run: run("run_gemini") } });
    progress.handleEvent({ type: "run.started", data: { run: run("run_codex", "acc_codex") } });

    assert.equal(container.children.length, 2);
    assert.equal(container.children[0].querySelector(".vera-run-progress__identity").textContent, "Gemini · gemini-flash");
    assert.equal(container.children[0].querySelector(".vera-run-progress__status").textContent, "working");
    assert.equal(container.children[0].querySelector(".vera-bubble__avatar").href, "#/agents/agt_acc_gemini");
    assert.equal(container.children[1].querySelector(".vera-run-progress__identity").textContent, "Codex · gpt-test");

    progress.handleEvent(state("acc_gemini", "coding", "editing files"));
    assert.equal(container.children[0].querySelector(".vera-run-progress__status").textContent, "coding · editing files");

    const background = container.children[0].querySelector(".vera-run-progress__background");
    assert.equal(background.hidden, true);
    clock = Date.parse("2026-07-29T00:00:10.000Z");
    for (const callback of timers) callback();
    assert.equal(background.hidden, false);
    await background.listeners.get("click")();
    assert.deepEqual(backgrounded, ["run_gemini"]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("a backgrounded Run leaves the composer foreground set but remains stoppable from its bubble", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const progress = createRunProgress({ now: () => Date.parse("2026-07-29T00:00:11.000Z") });
    progress.setContext({ spaceId: "spc_group", spaceSessionId: "sps_group", isGroupChat: true });
    progress.handleEvent({ type: "run.started", data: { run: run("run_gemini") } });
    assert.deepEqual(progress.foregroundRuns().map((item) => item.id), ["run_gemini"]);

    progress.handleEvent({
      type: "run.backgrounded",
      data: { run: { ...run("run_gemini"), backgroundedAt: "2026-07-29T00:00:11.000Z" } },
    });
    assert.deepEqual(progress.foregroundRuns(), []);
    assert.equal(progress.actionForRun("run_gemini").kind, "stop");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("first real Message or terminal Run removes only its matching placeholder", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const container = new FakeElement("div");
    const progress = createRunProgress();
    progress.setContext({ spaceId: "spc_group", spaceSessionId: "sps_group", isGroupChat: true });
    progress.attach(container);
    progress.handleEvent({ type: "run.started", data: { run: run("run_gemini") } });
    progress.handleEvent({ type: "run.started", data: { run: run("run_codex", "acc_codex") } });

    progress.handleEvent({
      type: "message.created",
      data: { message: { runId: "run_gemini" } },
    });
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].dataset.runId, "run_codex");

    progress.handleEvent({
      type: "run.ended",
      data: { run: { id: "run_codex" } },
    });
    assert.equal(container.children.length, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
