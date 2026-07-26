import test from "node:test";
import assert from "node:assert/strict";

import {
  confirmNavigatorAction,
  confirmSpaceDeletion,
} from "../../../frontend/src/components/navigator-dialogs.js";
import {
  requestGroupDetails,
  requestNavigatorText,
  requestSpaceDetails,
} from "../../../frontend/src/components/navigator-form-dialogs.js";

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.focusCount = 0;
  }

  get isConnected() {
    return this === this.ownerDocument.root || Boolean(this.parentNode?.isConnected);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index !== -1) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  querySelectorAll(selector) {
    const tags = new Set(["button", "input", "select", "textarea", "a"]);
    const descendants = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (tags.has(child.tagName) && selector.includes(child.tagName)) descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    return descendants;
  }

  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    let match = null;
    const visit = (node) => {
      for (const child of node.children) {
        if (child.className.split(/\s+/u).includes(className)) {
          match = child;
          return;
        }
        visit(child);
        if (match) return;
      }
    };
    visit(this);
    return match;
  }
}

function createDocumentFixture() {
  const document = {
    activeElement: null,
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
  };
  document.root = new FakeElement("root", document);
  return document;
}

async function verifyAbort(run, sentinel) {
  const previousDocument = globalThis.document;
  const document = createDocumentFixture();
  globalThis.document = document;
  try {
    const trigger = document.createElement("button");
    document.root.appendChild(trigger);
    trigger.focus();
    const host = document.createElement("aside");
    document.root.appendChild(host);
    const controller = new AbortController();
    const pending = run(host, controller.signal);
    assert.equal(host.children.length, 1);

    controller.abort();
    assert.deepEqual(await pending, sentinel);
    assert.equal(host.children.length, 0);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.focusCount, 2);

    controller.abort();
    assert.equal(trigger.focusCount, 2);
  } finally {
    globalThis.document = previousDocument;
  }
}

test("every navigator dialog resolves its cancel sentinel when aborted", async () => {
  await verifyAbort(
    (host, signal) => requestNavigatorText(host, "名称", "", { signal }),
    null,
  );
  await verifyAbort(
    (host, signal) => requestGroupDetails(host, { title: "群聊", accounts: [], signal }),
    null,
  );
  await verifyAbort(
    (host, signal) => requestSpaceDetails(host, { title: "Space", signal }),
    null,
  );
  await verifyAbort(
    (host, signal) => confirmNavigatorAction(host, "确认？", { signal }),
    false,
  );
  await verifyAbort(
    (host, signal) => confirmSpaceDeletion(
      host,
      { name: "One" },
      { messageCount: 1, affectedMemoryCount: 0, exclusiveMemoryCount: 0 },
      { signal },
    ),
    null,
  );
});

test("an embedded Project dialog inherits the Space dialog AbortSignal", async () => {
  const previousDocument = globalThis.document;
  const document = createDocumentFixture();
  globalThis.document = document;
  try {
    const host = document.createElement("aside");
    document.root.appendChild(host);
    const controller = new AbortController();
    let projectCreates = 0;
    const pending = requestSpaceDetails(host, {
      title: "Space",
      signal: controller.signal,
      onCreateProject() {
        projectCreates += 1;
      },
    });
    const outerDialog = host.children[0];
    const addProject = outerDialog.querySelectorAll("button")
      .find((button) => button.textContent === "新建 Project");
    addProject.dispatchEvent({ type: "click" });
    assert.equal(host.children.length, 2);

    controller.abort();
    assert.equal(await pending, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(host.children.length, 0);
    assert.equal(projectCreates, 0);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("editing a Space never returns the immutable Space Type", async () => {
  const previousDocument = globalThis.document;
  const document = createDocumentFixture();
  globalThis.document = document;
  try {
    const host = document.createElement("aside");
    document.root.appendChild(host);
    const pending = requestSpaceDetails(host, {
      title: "编辑 Space",
      initialValue: { name: "One", spaceType: "library" },
      allowSpaceType: false,
    });
    const dialog = host.children[0];
    const inputs = dialog.querySelectorAll("input");
    inputs[0].value = "Renamed";
    dialog.dispatchEvent({
      type: "submit",
      preventDefault() {},
    });

    assert.deepEqual(await pending, {
      name: "Renamed",
      projectId: null,
    });
  } finally {
    globalThis.document = previousDocument;
  }
});
