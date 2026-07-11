import test from "node:test";
import assert from "node:assert/strict";

import { createAppRouter, parseRoute } from "../../../frontend/src/state/router.js";

function createFixture({ hash = "#/", loadSpaceView } = {}) {
  const listeners = new Map();
  const children = [];
  const root = {
    children,
    appendChild(node) {
      children.push(node);
    },
    replaceChildren(...nodes) {
      children.splice(0, children.length, ...nodes);
    },
  };
  const windowTarget = {
    location: { hash },
    document: {
      createElement(tagName) {
        const node = {
          tagName,
          className: "",
          textContent: "",
          children: [],
          appendChild(child) {
            child.parentNode = node;
            node.children.push(child);
          },
          replaceChildren(...nextChildren) {
            node.children.splice(0, node.children.length, ...nextChildren);
          },
          remove() {
            const siblings = this.parentNode?.children ?? children;
            const index = siblings.indexOf(this);
            if (index !== -1) siblings.splice(index, 1);
          },
        };
        return node;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const router = createAppRouter({
    root,
    platform: { kind: "web" },
    windowTarget,
    loadSpaceView,
  });
  return { root, router, windowTarget, listeners };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("parseRoute recognizes the chat root and encoded Space ids", () => {
  assert.deepEqual(parseRoute(""), { name: "space", spaceId: null });
  assert.deepEqual(parseRoute("#/"), { name: "space", spaceId: null });
  assert.deepEqual(parseRoute("#/spaces/spc_123"), { name: "space", spaceId: "spc_123" });
  assert.deepEqual(parseRoute("#/spaces/space%20name/"), { name: "space", spaceId: "space name" });
  assert.deepEqual(parseRoute("#/spaces/%zz"), { name: "not-found", path: "/spaces/%zz" });
});

test("parseRoute returns a not-found route for unsupported paths", () => {
  assert.deepEqual(parseRoute("#/settings"), { name: "not-found", path: "/settings" });
  assert.deepEqual(parseRoute("#/spaces/spc_1/settings"), {
    name: "not-found",
    path: "/spaces/spc_1/settings",
  });
});

test("start mounts the current route once and stop removes listener and view", async () => {
  const mounts = [];
  let cleanupCount = 0;
  const fixture = createFixture({
    hash: "#/spaces/spc_start",
    loadSpaceView: async () => ({
      async mountSpaceView(options) {
        mounts.push(options);
        options.root.appendChild({ route: options.spaceId });
        return () => {
          cleanupCount += 1;
        };
      },
    }),
  });

  await fixture.router.start();
  await fixture.router.start();

  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].spaceId, "spc_start");
  assert.equal(mounts[0].platform.kind, "web");
  assert.equal(fixture.listeners.has("hashchange"), true);
  assert.equal(fixture.root.children[0].children.length, 1);
  assert.equal(fixture.root.children[0].children[0].route, "spc_start");

  fixture.router.stop();
  fixture.router.stop();

  assert.equal(cleanupCount, 1);
  assert.equal(fixture.listeners.has("hashchange"), false);
  assert.deepEqual(fixture.root.children, []);
});

test("hash navigation cleans up the previous route before mounting the next", async () => {
  const calls = [];
  const fixture = createFixture({
    hash: "#/spaces/spc_first",
    loadSpaceView: async () => ({
      async mountSpaceView({ root, spaceId }) {
        calls.push(`mount:${spaceId}`);
        root.appendChild({ route: spaceId });
        return () => calls.push(`cleanup:${spaceId}`);
      },
    }),
  });

  await fixture.router.start();
  fixture.windowTarget.location.hash = "#/spaces/spc_second";
  fixture.listeners.get("hashchange")();
  await flushAsyncWork();

  assert.deepEqual(calls, ["mount:spc_first", "cleanup:spc_first", "mount:spc_second"]);
  assert.equal(fixture.root.children[0].children[0].route, "spc_second");

  fixture.router.stop();
});

test("unknown routes replace the active view with a lightweight error", async () => {
  let cleanupCount = 0;
  const fixture = createFixture({
    hash: "#/spaces/spc_known",
    loadSpaceView: async () => ({
      async mountSpaceView({ root }) {
        root.appendChild({ route: "known" });
        return () => {
          cleanupCount += 1;
        };
      },
    }),
  });

  await fixture.router.start();
  fixture.windowTarget.location.hash = "#/does-not-exist";
  fixture.listeners.get("hashchange")();
  await flushAsyncWork();

  assert.equal(cleanupCount, 1);
  assert.equal(fixture.root.children.length, 1);
  assert.equal(fixture.root.children[0].className, "vera-route-error");
  assert.equal(fixture.root.children[0].textContent, "页面不存在");

  fixture.router.stop();
});

test("a stale async route load cannot mount after a newer navigation", async () => {
  let resolveFirstLoad;
  let loadCount = 0;
  const mounts = [];
  const firstLoad = new Promise((resolve) => {
    resolveFirstLoad = resolve;
  });
  const module = {
    async mountSpaceView({ root, spaceId }) {
      mounts.push(spaceId);
      root.appendChild({ route: spaceId });
      return () => {};
    },
  };
  const fixture = createFixture({
    hash: "#/spaces/spc_slow",
    loadSpaceView: () => {
      loadCount += 1;
      return loadCount === 1 ? firstLoad : Promise.resolve(module);
    },
  });

  const starting = fixture.router.start();
  fixture.windowTarget.location.hash = "#/spaces/spc_fast";
  fixture.listeners.get("hashchange")();
  await flushAsyncWork();

  resolveFirstLoad(module);
  await starting;
  await flushAsyncWork();

  assert.deepEqual(mounts, ["spc_fast"]);
  assert.equal(fixture.root.children[0].children[0].route, "spc_fast");

  fixture.router.stop();
});
