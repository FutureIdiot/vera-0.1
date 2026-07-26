import test from "node:test";
import assert from "node:assert/strict";

import {
  createTimelineCache,
  timelineItemsMatch,
} from "../../../frontend/src/state/timeline-cache.js";

test("timeline comparison accepts the API's latest-first ordering", () => {
  const first = { id: "msg_1", itemType: "message", content: "one" };
  const second = { id: "msg_2", itemType: "message", content: "two" };

  assert.equal(timelineItemsMatch([first, second], [second, first]), true);
  assert.equal(timelineItemsMatch([first, second], [{ ...second, content: "changed" }, first]), false);
});

test("timeline cache restores only the matching active SpaceSession", () => {
  const cache = createTimelineCache();
  const items = [{ id: "msg_1", itemType: "message" }];
  cache.set("spc_1", {
    spaceSessionId: "ses_1",
    items,
    hasOlder: true,
    seq: 12,
  });

  assert.equal(cache.get("spc_1", "ses_2"), null);
  assert.deepEqual(cache.get("spc_1", "ses_1"), {
    spaceSessionId: "ses_1",
    items,
    hasOlder: true,
    seq: 12,
  });
});

test("timeline cache bounds both retained Spaces and items", () => {
  const cache = createTimelineCache({ maxSpaces: 2, maxItems: 2 });
  cache.set("spc_1", {
    spaceSessionId: "ses_1",
    items: [{ id: "1" }, { id: "2" }, { id: "3" }],
  });
  cache.set("spc_2", { spaceSessionId: "ses_2", items: [] });
  assert.deepEqual(cache.get("spc_1", "ses_1").items, [{ id: "2" }, { id: "3" }]);
  cache.set("spc_3", { spaceSessionId: "ses_3", items: [] });

  assert.equal(cache.get("spc_2", "ses_2"), null);
  assert.notEqual(cache.get("spc_1", "ses_1"), null);
  assert.notEqual(cache.get("spc_3", "ses_3"), null);
});
