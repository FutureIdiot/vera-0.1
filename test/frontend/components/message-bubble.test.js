import test from "node:test";
import assert from "node:assert/strict";

import { renderMessageBubble } from "../../../frontend/src/components/message-bubble.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.href = "";
    this.title = "";
    this._textContent = "";
    this.listeners = new Map();
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(" ");
      },
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, force) => {
        const present = this.className.split(" ").includes(name);
        const next = force === undefined ? !present : force;
        const classes = new Set(this.className.split(" ").filter(Boolean));
        if (next) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    if (value === "") this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  prepend(child) {
    this.children.unshift(child);
  }

  appendChild(child) {
    this.children.push(child);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

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

  querySelectorAll(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    if (!className) return [];
    const matches = [];
    for (const child of this.children) {
      if (child.className.split(" ").includes(className)) matches.push(child);
      matches.push(...(child.querySelectorAll?.(selector) ?? []));
    }
    return matches;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "href") this.href = "";
    if (name === "title") this.title = "";
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
}

test("Account message avatar keeps the Account identity and model snapshot", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_1",
      itemType: "message",
      status: "completed",
      author: {
        type: "account",
        accountId: "acc one",
        accountNameSnapshot: "Gemma",
        executingAgentId: "agt one",
        effectiveModel: "gemma-test",
        delegated: false,
      },
      content: "hello",
    });

    const avatar = bubble.querySelector(".vera-bubble__avatar");
    const author = bubble.querySelector(".vera-bubble__author");
    assert.equal(avatar.href, "#/settings/accounts/acc%20one");
    assert.equal(avatar.textContent, "G");
    assert.equal(avatar.attributes["aria-label"], "打开 Gemma 设置");
    assert.equal(author.textContent, "Gemma · gemma-test");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("user messages do not expose an Agent avatar link", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_2",
      itemType: "message",
      status: "completed",
      author: { type: "user" },
      content: "hello",
    });

    const avatar = bubble.querySelector(".vera-bubble__avatar");
    assert.equal(avatar.hidden, true);
    assert.equal(avatar.href, "");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("available and deleted attachments render as safe message projections", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_3",
      spaceId: "spc one",
      itemType: "message",
      status: "completed",
      author: { type: "user" },
      content: "",
      attachments: [
        { fileId: "fil one", name: "brief.pdf", state: "available" },
        { fileId: "fil_gone", name: "old.txt", state: "deleted" },
      ],
    });

    const attachments = bubble.querySelector(".vera-bubble__attachments");
    assert.equal(attachments.hidden, false);
    assert.equal(attachments.children.length, 2);
    assert.equal(attachments.children[0].tagName, "a");
    assert.equal(
      attachments.children[0].href,
      "/api/spaces/spc%20one/files/fil%20one/download",
    );
    assert.equal(attachments.children[0].download, "brief.pdf");
    assert.equal(attachments.children[1].tagName, "span");
    assert.equal(attachments.children[1].textContent, "old.txt（不可用）");
    assert.equal(attachments.children[1].href, "");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("message time appears only inside the bubble and flat action interfaces stay explicit", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_4",
      itemType: "message",
      status: "completed",
      createdAt: "2026-07-24T01:02:03.000Z",
      author: { type: "user" },
      content: "hello",
    }, { onCopy() {} });

    assert.equal(bubble.querySelectorAll(".vera-bubble__time").length, 1);
    const actions = bubble.querySelectorAll(".vera-bubble__action");
    assert.equal(actions.length, 4);
    assert.deepEqual(actions.map((button) => button.dataset.action), ["retry", "branch", "save", "copy"]);
    assert.deepEqual(actions.map((button) => button.disabled), [true, true, true, false]);
  } finally {
    globalThis.document = previousDocument;
  }
});
