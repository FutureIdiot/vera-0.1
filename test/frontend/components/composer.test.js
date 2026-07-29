import test from "node:test";
import assert from "node:assert/strict";

import {
  createComposer,
  DEFAULT_COMMANDS,
  resolveMessageTarget,
} from "../../../frontend/src/components/composer.js";

const targets = [
  { id: "acc_alpha", name: "Alpha" },
  { id: "acc_al", name: "Al" },
  { id: "acc_beta_1", name: "Beta" },
  { id: "acc_beta_2", name: "Beta" },
];

test("composer broadcasts messages without a known Account mention", () => {
  assert.deepEqual(resolveMessageTarget("大家看看", targets), { type: "broadcast" });
  assert.deepEqual(resolveMessageTarget("联系 test@example.com", targets), { type: "broadcast" });
});

test("composer resolves inline Account mentions without a separate target selector", () => {
  assert.deepEqual(resolveMessageTarget("@Alpha 请处理，@Beta 复核", targets), {
    type: "direct",
    accountIds: ["acc_alpha", "acc_beta_1", "acc_beta_2"],
  });
});

test("composer prefers the longest Account name at the same mention position", () => {
  assert.deepEqual(resolveMessageTarget("@Alpha继续", targets), {
    type: "direct",
    accountIds: ["acc_alpha"],
  });
});

test("composer exposes real commands and keeps future command interfaces disabled", () => {
  assert.deepEqual(
    DEFAULT_COMMANDS.filter((item) => item.available).map((item) => item.command),
    ["/new", "/compact"],
  );
  assert.deepEqual(
    DEFAULT_COMMANDS.filter((item) => !item.available).map((item) => item.command),
    ["/resume", "/forge", "/clear", "/export", "/theme", "/help"],
  );
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.style = {};
    this.value = "";
    this.selectionStart = 0;
    this.scrollHeight = 0;
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
  querySelectorAll() { return []; }
  focus() {}
}

test("composer keeps one in-flight submit even when submit events re-enter synchronously", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  try {
    const composer = createComposer({
      async onSend() {
        calls += 1;
        await pending;
      },
    });
    composer.input.value = "send once";
    const submit = composer.element.listeners.get("submit");
    const event = { preventDefault() {} };
    submit(event);
    submit(event);
    assert.equal(calls, 1);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    composer.input.value = "send again";
    submit(event);
    assert.equal(calls, 2);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    globalThis.document = previousDocument;
  }
});

test("private Chat replaces the single send control with direct stop while a foreground Run is active", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  const stopped = [];
  try {
    const composer = createComposer({
      onStop: async (runId) => { stopped.push(runId); },
    });
    const send = composer.element.children[3].children.at(-1);
    composer.setForegroundRuns([{
      id: "run_private",
      role: "root",
      status: "running",
      accountId: "acc_alpha",
      accountNameSnapshot: "Alpha",
      backgroundedAt: null,
      outputPolicy: "space",
    }], { isGroupChat: false });
    assert.equal(send.type, "button");
    assert.equal(send.attributes["aria-label"], "中止工作");
    await send.listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopped, ["run_private"]);

    composer.setForegroundRuns([], { isGroupChat: false });
    assert.equal(send.type, "submit");
    assert.equal(send.attributes["aria-label"], "发送消息");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("group Chat uses the single stop control to open an upward Account chooser", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  const stopped = [];
  try {
    const composer = createComposer({
      targets,
      onStop: async (runId) => { stopped.push(runId); },
    });
    const stopMenu = composer.element.children[2];
    const send = composer.element.children[3].children.at(-1);
    composer.setForegroundRuns([
      { id: "run_alpha", role: "root", status: "running", accountId: "acc_alpha", outputPolicy: "space" },
      { id: "run_beta", role: "root", status: "pending", accountId: "acc_beta_1", outputPolicy: "space" },
    ], { isGroupChat: true });

    send.listeners.get("click")();
    assert.equal(stopMenu.hidden, false);
    assert.equal(stopMenu.children.length, 2);
    await stopMenu.children[1].listeners.get("click")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopped, ["run_beta"]);
  } finally {
    globalThis.document = previousDocument;
  }
});
