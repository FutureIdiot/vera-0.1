import test from "node:test";
import assert from "node:assert/strict";

import {
  activityIconName,
  activitySummary,
  applyActivity,
  renderActivity,
} from "../../../frontend/src/components/activity-item.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.type = "";
    this._textContent = "";
    this.listeners = new Map();
    this.classList = {
      add: (...names) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        for (const name of names) classes.add(name);
        this.className = [...classes].join(" ");
      },
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        const next = force ?? !classes.has(name);
        if (next) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join("");
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
    if (value === "") this.children = [];
  }

  append(...children) {
    this.children.push(...children);
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

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  click() {
    this.listeners.get("click")?.({ currentTarget: this });
  }
}

function withFakeDocument(run) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
  };
  try {
    run();
  } finally {
    globalThis.document = previousDocument;
  }
}

test("status-only thinking renders one summary line and never exposes detail", () => {
  withFakeDocument(() => {
    const activity = renderActivity({
      id: "act_thinking",
      phase: "thinking",
      kind: "reasoning",
      summary: "正在分析请求",
      detail: "第一步\n第二步",
    }, { canExpand: false });

    assert.equal(activity.querySelector(".vera-activity__summary").textContent, "正在分析请求");
    assert.equal(activity.querySelector(".vera-activity__toggle").disabled, true);
    assert.equal(activity.querySelector(".vera-vector-icon").dataset.icon, "reasoning");
    assert.equal(activity.querySelector(".vera-activity__detail").textContent, "");
    assert.equal(activity.classList.contains("is-expanded"), false);
  });
});

test("observed public reasoning starts expanded and the whole summary row toggles it", () => {
  withFakeDocument(() => {
    const activity = renderActivity({
      id: "act_reasoning",
      phase: "thinking",
      kind: "reasoning",
      summary: "正在比较两个实现",
      detail: "方案一的权衡\n方案二的权衡",
    }, { canExpand: true });
    const toggle = activity.querySelector(".vera-activity__toggle");
    const detail = activity.querySelector(".vera-activity__detail");

    assert.equal(activity.classList.contains("is-expanded"), true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.textContent, "正在比较两个实现");
    assert.equal(detail.hidden, false);
    assert.match(detail.textContent, /方案二/u);

    toggle.click();
    assert.equal(activity.classList.contains("is-expanded"), false);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(detail.hidden, true);
  });
});

test("tool updates preserve the user's collapsed preference", () => {
  withFakeDocument(() => {
    const item = {
      id: "act_tool",
      phase: "tool",
      kind: "command",
      label: "bash",
      summary: "运行测试",
      detail: "npm test",
      toolStatus: "running",
    };
    const activity = renderActivity(item, { canExpand: true });
    activity.querySelector(".vera-activity__toggle").click();

    applyActivity(activity, {
      ...item,
      summary: "已运行测试",
      detail: "npm test\n18 passed",
      toolStatus: "completed",
    }, { canExpand: true });

    assert.equal(activity.classList.contains("is-expanded"), false);
    assert.equal(activity.querySelector(".vera-activity__detail").hidden, true);
    assert.equal(activitySummary({ ...item, summary: "已运行测试", toolStatus: "completed" }), "已运行测试");
    assert.equal(activityIconName(item), "command");
  });
});

test("providers without public reasoning detail stay as the same non-expandable summary", () => {
  withFakeDocument(() => {
    const activity = renderActivity({
      id: "act_codex",
      phase: "thinking",
      kind: "reasoning",
      summary: "正在思考",
      detail: null,
    }, { canExpand: true });

    assert.equal(activity.querySelector(".vera-activity__toggle").disabled, true);
    assert.equal(activity.querySelector(".vera-activity__detail").textContent, "");
    assert.equal(activity.querySelector(".vera-activity__summary").textContent, "正在思考");
  });
});

test("unified Activity kinds select their own vector icons without provider labels", () => {
  withFakeDocument(() => {
    const activity = renderActivity({
      id: "act_read",
      phase: "tool",
      kind: "read",
      label: "Read",
      summary: "已读取文件",
      detail: null,
    }, { canExpand: false });

    assert.equal(activity.querySelector(".vera-vector-icon").dataset.icon, "read");
    assert.equal(activity.querySelector(".vera-activity__summary").textContent, "已读取文件");
    assert.equal(activity.querySelector(".vera-activity__toggle").textContent, "已读取文件");
    assert.equal(activity.querySelector(".vera-activity__toggle").getAttribute("aria-label"), "读取文件摘要");
  });
});
