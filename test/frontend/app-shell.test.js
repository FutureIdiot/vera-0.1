import test from "node:test";
import assert from "node:assert/strict";

import {
  clampNavigatorWidth,
  resolveSpaceIdentity,
  resolveNavigatorState,
  resolveShellHeader,
} from "../../frontend/src/components/app-shell.js";

const space = { id: "spc_one", name: "One" };

test("navigator width stays inside its tokenized resize bounds", () => {
  assert.equal(clampNavigatorWidth(280, 320, 720), 320);
  assert.equal(clampNavigatorWidth(520, 320, 720), 520);
  assert.equal(clampNavigatorWidth(900, 320, 720), 720);
  assert.equal(clampNavigatorWidth(300, 320, 280), 320);
});

test("chat top bar uses the left control for the directory and the Space title for settings", () => {
  assert.deepEqual(resolveShellHeader({ routeName: "space", currentSpace: space }), {
    leadingText: "目录",
    leadingHref: "#/spaces",
    leadingLabel: "打开 Space 目录",
    title: "One",
    subtitle: "尚未添加 Account",
    titleHref: "#/spaces/spc_one/settings",
    titleLabel: "打开 One 的 Space 设置",
    titleIsHeading: false,
    settingsVisible: true,
  });
});

test("private header shows Account name and current model while group header shows Space name", () => {
  const accounts = [
    { id: "acc_a", name: "Coder", model: "gpt-5.6-sol" },
    { id: "acc_b", name: "Reviewer", model: "claude-sonnet" },
  ];
  const privateSpace = { id: "spc_private", name: "Implementation", seats: [{ accountId: "acc_a" }] };
  const groupSpace = {
    id: "spc_group",
    name: "Release Room",
    seats: [{ accountId: "acc_a" }, { accountId: "acc_b" }],
  };

  assert.deepEqual(resolveSpaceIdentity(privateSpace, accounts), {
    title: "Coder",
    subtitle: "gpt-5.6-sol",
  });
  assert.deepEqual(resolveSpaceIdentity(groupSpace, accounts), {
    title: "Release Room",
    subtitle: "2 个 Account · Coder、Reviewer",
  });
});

test("all management routes expose one top-bar back action and one heading", () => {
  const header = resolveShellHeader({ routeName: "space-settings", currentSpace: space });
  assert.equal(header.leadingHref, "#/spaces/spc_one");
  assert.equal(header.leadingText, "返回");
  assert.equal(header.title, "当前 Space 设置");
  assert.equal(header.titleHref, null);
  assert.equal(header.titleIsHeading, true);
  assert.equal(header.settingsVisible, false);

  const dynamic = resolveShellHeader({
    routeName: "account-detail",
    currentSpace: space,
    managementHeader: { title: "Gemma", backHref: "#/settings/accounts", backLabel: "返回" },
  });
  assert.equal(dynamic.title, "Gemma");
  assert.equal(dynamic.leadingHref, "#/settings/accounts");

  const agent = resolveShellHeader({
    routeName: "agent-detail",
    currentSpace: space,
    managementHeader: { title: "Gemma", backHref: "#/spaces/spc_one", backLabel: "返回" },
  });
  assert.equal(agent.title, "Gemma");
  assert.equal(agent.leadingHref, "#/spaces/spc_one");

  const files = resolveShellHeader({ routeName: "space-files", currentSpace: space });
  assert.equal(files.title, "Files");
  assert.equal(files.leadingHref, "#/spaces/spc_one");
});

test("the directory stays open across chat routes but never enters settings", () => {
  assert.deepEqual(resolveNavigatorState({ routeName: "space", navigatorOpen: true }), {
    visible: true,
  });
  assert.deepEqual(resolveNavigatorState({ routeName: "space", navigatorOpen: false }), {
    visible: false,
  });
  assert.deepEqual(resolveNavigatorState({ routeName: "space-settings", navigatorOpen: true }), {
    visible: false,
  });
  assert.deepEqual(resolveNavigatorState({ routeName: "settings", navigatorOpen: true }), {
    visible: false,
  });
});
