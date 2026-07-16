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

  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    return this.children.find((child) => className && child.className.split(" ").includes(className)) ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === "href") this.href = "";
    if (name === "title") this.title = "";
  }
}

test("agent message avatar links to the shared Agent usage page", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
  try {
    const bubble = renderMessageBubble({
      id: "msg_1",
      itemType: "message",
      status: "completed",
      author: { type: "agent", agentId: "agt one" },
      content: "hello",
    }, { agentName: () => "Gemma" });

    const avatar = bubble.querySelector(".vera-bubble__avatar");
    assert.equal(avatar.href, "#/agents/agt%20one");
    assert.equal(avatar.textContent, "G");
    assert.equal(avatar.attributes["aria-label"], "打开 Gemma 设置");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("user messages do not expose an Agent avatar link", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
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
  globalThis.document = { createElement: (tagName) => new FakeElement(tagName) };
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
