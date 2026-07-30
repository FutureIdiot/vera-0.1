import test from "node:test";
import assert from "node:assert/strict";

import {
  renderMessageBubble,
  resolveMessageGrouping,
} from "../../../frontend/src/components/message-bubble.js";

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
    return this._textContent + this.children.map((child) => child.textContent ?? "").join("");
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

test("group Account message uses top-level frozen identity and model fields", () => {
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
      },
      accountNameSnapshot: "Gemma",
      executingAgentId: "agt one",
      effectiveModel: "gemma-test",
      delegated: false,
      content: "hello",
    }, {
      grouping: { position: "solo", showAuthor: true, showAvatar: true, showTail: true },
    });

    const avatar = bubble.querySelector(".vera-bubble__avatar");
    const author = bubble.querySelector(".vera-bubble__author");
    assert.equal(avatar.href, "#/agents/agt%20one");
    assert.equal(avatar.textContent, "G");
    assert.equal(avatar.attributes["aria-label"], "打开 Gemma 的 Agent 设置");
    assert.equal(author.textContent, "Gemma · gemma-test");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("Account replies render GFM blocks without turning remote images into active content", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_markdown",
      itemType: "message",
      status: "completed",
      author: { type: "account", accountId: "acc_one" },
      content: [
        "**结论**",
        "",
        "| A | B |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```js",
        "const value = veryLongExpression();",
        "```",
        "",
        "![diagram](https://example.com/diagram.png)",
      ].join("\n"),
    });

    const text = bubble.querySelector(".vera-bubble__text");
    const markdown = text.children[0];
    assert.equal(text.classList.contains("is-markdown"), true);
    assert.equal(markdown.className, "vera-markdown");
    assert.equal(markdown.children[0].children[0].tagName, "strong");
    assert.equal(markdown.children.some((child) => child.className === "vera-markdown__table-wrap"), true);
    assert.equal(markdown.children.some((child) => child.tagName === "pre"), true);
    assert.equal(markdown.children.some((child) => child.tagName === "img"), false);
    assert.match(text.textContent, /图片：diagram/u);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("private Account message hides the repeated name and model", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_private",
      itemType: "message",
      status: "completed",
      author: { type: "account", accountId: "acc_one" },
      accountNameSnapshot: "Gemma",
      effectiveModel: "gemma-test",
      content: "hello",
    }, {
      isGroupChat: false,
      grouping: { position: "solo", showAuthor: false, showAvatar: true, showTail: true },
    });

    const avatar = bubble.querySelector(".vera-bubble__avatar");
    assert.equal(bubble.classList.contains("vera-bubble--private-agent"), true);
    assert.equal(avatar.hidden, true);
    assert.equal(avatar.href, "");
    assert.equal(bubble.querySelector(".vera-bubble__author").hidden, true);
    assert.equal(bubble.querySelector(".vera-bubble__author").textContent, "");
  } finally {
    globalThis.document = previousDocument;
  }
});

test("only the latest provider Message exposes the avatar and tail", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const item = {
      id: "msg_split",
      itemType: "message",
      status: "completed",
      author: { type: "account", accountId: "acc_one" },
      accountNameSnapshot: "Gemma",
      effectiveModel: "gemma-test",
      content: "hello",
    };
    const first = renderMessageBubble(item, {
      grouping: { position: "first", showAuthor: true, showAvatar: false, showTail: false },
    });
    const last = renderMessageBubble({ ...item, id: "msg_latest" }, {
      grouping: { position: "last", showAuthor: false, showAvatar: true, showTail: true },
    });

    assert.equal(first.querySelector(".vera-bubble__avatar").classList.contains("is-placeholder"), true);
    assert.equal(first.classList.contains("vera-bubble--has-tail"), false);
    assert.equal(first.querySelector(".vera-bubble__author").textContent, "Gemma · gemma-test");
    assert.equal(last.querySelector(".vera-bubble__avatar").classList.contains("is-placeholder"), false);
    assert.equal(last.classList.contains("vera-bubble--has-tail"), true);
    assert.equal(last.querySelector(".vera-bubble__author").hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("user message groups hide avatars and expose a tail only on the latest bubble", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const items = [
      { ...userMessage("msg_2"), status: "completed", content: "first" },
      { ...userMessage("msg_3"), status: "completed", content: "latest" },
    ];
    const first = renderMessageBubble(items[0], {
      grouping: resolveMessageGrouping(items, 0),
    });
    const last = renderMessageBubble(items[1], {
      grouping: resolveMessageGrouping(items, 1),
    });

    assert.equal(first.querySelector(".vera-bubble__avatar").hidden, true);
    assert.equal(first.querySelector(".vera-bubble__avatar").href, "");
    assert.equal(first.classList.contains("vera-bubble--has-tail"), false);
    assert.equal(last.querySelector(".vera-bubble__avatar").hidden, true);
    assert.equal(last.classList.contains("vera-bubble--has-tail"), true);
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

    const content = bubble.querySelector(".vera-bubble__content");
    const text = bubble.querySelector(".vera-bubble__text");
    const meta = bubble.querySelector(".vera-bubble__meta");
    assert.equal(bubble.querySelectorAll(".vera-bubble__time").length, 1);
    assert.equal(text.textContent, "hello");
    assert.equal(content.children.at(-1), meta);
    assert.equal(meta.hidden, false);
    const actions = bubble.querySelectorAll(".vera-bubble__action");
    assert.equal(actions.length, 7);
    assert.deepEqual(
      actions.map((button) => button.dataset.action),
      ["background", "stop", "retry", "branch", "save", "copy", "edit"],
    );
    assert.deepEqual(actions.map((button) => button.disabled), [true, true, true, true, true, false, true]);
    assert.deepEqual(
      actions.filter((button) => !button.hidden).map((button) => button.dataset.action),
      ["copy", "edit"],
    );
  } finally {
    globalThis.document = previousDocument;
  }
});

test("the latest active Run bubble carries work status and its eligible background action", () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    const bubble = renderMessageBubble({
      id: "msg_active",
      itemType: "message",
      status: "streaming",
      author: { type: "account", accountId: "acc_one" },
      content: "working",
    }, {
      workStatus: "coding · editing files",
      onBackground() {},
    });
    assert.equal(bubble.querySelector(".vera-bubble__work-status").textContent, "coding · editing files");
    assert.equal(bubble.querySelector(".vera-bubble__work-status").hidden, false);
    const background = bubble.querySelector(".vera-bubble__action--background");
    assert.equal(background.hidden, false);
    assert.equal(background.disabled, false);
  } finally {
    globalThis.document = previousDocument;
  }
});

function accountMessage(id, runId, accountId = "acc_a") {
  return {
    id,
    itemType: "message",
    runId,
    author: { type: "account", accountId },
  };
}

function userMessage(id) {
  return {
    id,
    itemType: "message",
    author: { type: "user" },
  };
}

test("same Account and run form first middle last bubbles in group chat", () => {
  const items = [
    accountMessage("msg_1", "run_1"),
    accountMessage("msg_2", "run_1"),
    accountMessage("msg_3", "run_1"),
  ];

  assert.deepEqual(resolveMessageGrouping(items, 0, { isGroupChat: true }), {
    position: "first",
    showAuthor: true,
    showAvatar: false,
    showTail: false,
  });
  assert.deepEqual(resolveMessageGrouping(items, 1, { isGroupChat: true }), {
    position: "middle",
    showAuthor: false,
    showAvatar: false,
    showTail: false,
  });
  assert.deepEqual(resolveMessageGrouping(items, 2, { isGroupChat: true }), {
    position: "last",
    showAuthor: false,
    showAvatar: true,
    showTail: true,
  });
});

test("private Account message groups never expose an avatar", () => {
  const items = [
    accountMessage("msg_1", "run_1"),
    accountMessage("msg_2", "run_1"),
  ];

  assert.equal(resolveMessageGrouping(items, 0).showAvatar, false);
  assert.equal(resolveMessageGrouping(items, 1).showAvatar, false);
});

test("adjacent user messages form first middle last bubbles without run ids", () => {
  const items = [
    userMessage("msg_user_1"),
    userMessage("msg_user_2"),
    userMessage("msg_user_3"),
  ];

  assert.deepEqual(resolveMessageGrouping(items, 0), {
    position: "first",
    showAuthor: false,
    showAvatar: false,
    showTail: false,
  });
  assert.deepEqual(resolveMessageGrouping(items, 1), {
    position: "middle",
    showAuthor: false,
    showAvatar: false,
    showTail: false,
  });
  assert.deepEqual(resolveMessageGrouping(items, 2), {
    position: "last",
    showAuthor: false,
    showAvatar: false,
    showTail: true,
  });
});

test("a new user message moves the tail from the former latest bubble", () => {
  const first = userMessage("msg_user_1");
  assert.equal(resolveMessageGrouping([first], 0).showTail, true);

  const items = [first, userMessage("msg_user_2")];
  assert.equal(resolveMessageGrouping(items, 0).position, "first");
  assert.equal(resolveMessageGrouping(items, 0).showTail, false);
  assert.equal(resolveMessageGrouping(items, 1).position, "last");
  assert.equal(resolveMessageGrouping(items, 1).showTail, true);
});

test("a new provider Message moves the avatar from the former latest bubble", () => {
  const first = accountMessage("msg_1", "run_1");
  assert.equal(resolveMessageGrouping([first], 0, { isGroupChat: true }).showAvatar, true);

  const items = [first, accountMessage("msg_2", "run_1")];
  assert.equal(resolveMessageGrouping(items, 0, { isGroupChat: true }).showAvatar, false);
  assert.equal(resolveMessageGrouping(items, 1, { isGroupChat: true }).showAvatar, true);
  assert.equal(resolveMessageGrouping(items, 0, { isGroupChat: true }).showAuthor, true);
});

test("different runs, Accounts, user messages, and Activity break bubble groups", () => {
  const accountA = accountMessage("msg_1", "run_1", "acc_a");
  const cases = [
    [accountA, accountMessage("msg_2", "run_2", "acc_a")],
    [accountA, accountMessage("msg_2", "run_1", "acc_b")],
    [accountA, { id: "msg_user", itemType: "message", author: { type: "user" } }],
    [accountA, { id: "act_1", itemType: "activity" }],
    [accountMessage("msg_legacy", null, "acc_a"), accountMessage("msg_2", null, "acc_a")],
  ];

  for (const items of cases) {
    assert.equal(resolveMessageGrouping(items, 0, { isGroupChat: true }).position, "solo");
    assert.equal(resolveMessageGrouping(items, 0, { isGroupChat: true }).showAvatar, true);
  }
});
