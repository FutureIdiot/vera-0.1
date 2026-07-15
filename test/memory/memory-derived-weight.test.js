import test from "node:test";
import assert from "node:assert/strict";
import { calculateMemoryDerivedWeights } from "../../src/memory/memory-derived-weight.js";

const NOW = "2026-07-15T00:00:00.000Z";
const daysAgo = (days) => new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();

function memory(slug, overrides = {}) {
  return {
    slug, type: "project_rule", status: "active", content: `${slug} body`,
    createdAt: NOW, updatedAt: NOW, stains: { agt_hidden: "#A1B2C3" }, ...overrides,
  };
}

function weights(memories, signals = []) {
  return calculateMemoryDerivedWeights({ agentId: "agt_alpha1", memories, signals, now: NOW });
}

test("all five normalized channels combine into one rebuildable clamped weight", () => {
  const memories = [
    memory("target"),
    memory("source-a", { content: "[[target]]" }),
    memory("source-b", { content: "[[target]] [[target]]" }),
  ];
  const signals = [
    { agentId: "agt_alpha1", slug: "target", kind: "detail_opened", createdAt: NOW },
    { agentId: "agt_alpha1", slug: "source-a", kind: "search_returned", createdAt: NOW },
    { agentId: "agt_alpha1", slug: "target", kind: "user_edited", createdAt: NOW },
    { id: "pin:agt_alpha1:target", agentId: "agt_alpha1", slug: "target", pinned: true, pinnedAt: NOW },
  ];
  const result = weights(memories, signals);
  assert.equal(result.get("target"), 1);
  assert.ok(result.get("source-a") < result.get("target"));
  assert.equal(result.has("source-b"), true);
});

test("usage combines log-normalized weighted count with latest-use recency", () => {
  const result = weights(
    [memory("detail"), memory("returned"), memory("old-detail")],
    [
      { agentId: "agt_alpha1", slug: "detail", kind: "detail_opened", createdAt: NOW },
      { agentId: "agt_alpha1", slug: "returned", kind: "auto_injected", createdAt: NOW },
      { agentId: "agt_alpha1", slug: "old-detail", kind: "detail_opened", createdAt: daysAgo(30) },
      { agentId: "agt_other1", slug: "returned", kind: "detail_opened", createdAt: NOW },
    ],
  );
  assert.equal(result.get("detail"), 0.4, "usage 1 plus fresh type decay 0.1");
  assert.equal(result.get("returned"), 0.280442, "one returned use is log-normalized before fresh recency is added");
  assert.equal(result.get("old-detail"), 0.355, "only latest-use recency decays; the accumulated count remains intact");
});

test("latest user edit and data-driven type half-lives decay independently", () => {
  const result = weights([
    memory("edited", { createdAt: daysAgo(3650), updatedAt: NOW }),
    memory("open", { type: "open_question", createdAt: daysAgo(90), updatedAt: NOW }),
    memory("decision", { type: "decision", createdAt: daysAgo(730), updatedAt: NOW }),
    memory("unknown", { type: "future_signal", createdAt: daysAgo(365), updatedAt: NOW }),
  ], [
    { agentId: "agt_alpha1", slug: "edited", kind: "user_edited", createdAt: daysAgo(360) },
    { agentId: "agt_alpha1", slug: "edited", kind: "user_edited", createdAt: daysAgo(180) },
  ]);
  assert.equal(result.get("edited"), 0.125, "project rule age and latest edit are each at one half-life");
  assert.equal(result.get("open"), 0.05);
  assert.equal(result.get("decision"), 0.05);
  assert.equal(result.get("unknown"), 0.05);
});

test("ordinary updatedAt changes never refresh type decay", () => {
  const original = weights([memory("rule", { createdAt: daysAgo(3650), updatedAt: daysAgo(3650) })]);
  const updated = weights([memory("rule", { createdAt: daysAgo(3650), updatedAt: NOW })]);
  assert.equal(original.get("rule"), 0.05);
  assert.deepEqual(updated, original);
});

test("inactive nodes, cross-Agent signals, and stains cannot affect active weights", () => {
  const active = memory("active");
  const archived = memory("archived", { status: "archived", content: "[[active]]" });
  const first = weights([active, archived], [
    { agentId: "agt_other1", slug: "active", kind: "detail_opened", createdAt: NOW },
  ]);
  const second = weights([{ ...active, stains: { agt_other: "#FFFFFF" } }, archived], []);
  assert.deepEqual(first, second);
  assert.equal(first.has("archived"), false);
  assert.equal(first.get("active"), 0.1);
});

test("input order does not change the slug-to-weight result", () => {
  const memories = [memory("b", { content: "[[a]]" }), memory("a")];
  const forward = weights(memories);
  const reversed = weights([...memories].reverse());
  assert.deepEqual(forward, reversed);
});
