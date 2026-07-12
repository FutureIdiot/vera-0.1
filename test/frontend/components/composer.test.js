import test from "node:test";
import assert from "node:assert/strict";

import { resolveMessageTarget } from "../../../frontend/src/components/composer.js";

const targets = [
  { id: "agt_alpha", name: "Alpha" },
  { id: "agt_al", name: "Al" },
  { id: "agt_beta_1", name: "Beta" },
  { id: "agt_beta_2", name: "Beta" },
];

test("composer broadcasts messages without a known Agent mention", () => {
  assert.deepEqual(resolveMessageTarget("大家看看", targets), { type: "broadcast" });
  assert.deepEqual(resolveMessageTarget("联系 test@example.com", targets), { type: "broadcast" });
});

test("composer resolves inline Agent mentions without a separate target selector", () => {
  assert.deepEqual(resolveMessageTarget("@Alpha 请处理，@Beta 复核", targets), {
    type: "direct",
    agentIds: ["agt_alpha", "agt_beta_1", "agt_beta_2"],
  });
});

test("composer prefers the longest Agent name at the same mention position", () => {
  assert.deepEqual(resolveMessageTarget("@Alpha继续", targets), {
    type: "direct",
    agentIds: ["agt_alpha"],
  });
});
