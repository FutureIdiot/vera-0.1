import test from "node:test";
import assert from "node:assert/strict";

import { resolveMessageTarget } from "../../../frontend/src/components/composer.js";

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
