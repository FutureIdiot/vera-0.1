import test from "node:test";
import assert from "node:assert/strict";

import {
  formatTimelineMarkdown,
  timelineExportFilename,
} from "../../../frontend/src/components/timeline-export.js";

test("timeline export writes the complete current Session in chronological Markdown", () => {
  const markdown = formatTimelineMarkdown({
    space: { id: "spc_1", name: "Project Alpha" },
    spaceSessionId: "sps_1",
    exportedAt: new Date("2026-07-30T12:00:00.000Z"),
    accountNames: new Map([["acc_1", "Codex"]]),
    items: [
      {
        id: "act_1",
        itemType: "activity",
        summary: "读取完成",
        createdAt: "2026-07-30T11:02:00.000Z",
      },
      {
        id: "msg_2",
        itemType: "message",
        author: { type: "account", accountId: "acc_1" },
        content: "完成了",
        status: "completed",
        createdAt: "2026-07-30T11:01:00.000Z",
        attachments: [{
          fileId: "fil_1",
          name: "result.txt",
          mime: "text/plain",
          sizeBytes: 42,
          state: "available",
        }],
      },
      {
        id: "msg_1",
        itemType: "message",
        author: { type: "user" },
        content: "开始",
        status: "completed",
        createdAt: "2026-07-30T11:00:00.000Z",
      },
    ],
  });

  assert.equal(markdown.startsWith("# Project Alpha\n"), true);
  assert.equal(markdown.includes("- SpaceSession: sps\\_1"), true);
  assert.equal(markdown.indexOf("## User") < markdown.indexOf("## Codex"), true);
  assert.equal(markdown.indexOf("## Codex") < markdown.indexOf("## Activity"), true);
  assert.equal(markdown.includes("result.txt · text/plain · 42 bytes · available · fil\\_1"), true);
});

test("timeline export filename removes filesystem-reserved characters", () => {
  assert.equal(
    timelineExportFilename({ name: "A/B: C" }, "sps_1"),
    "vera-A-B--C-sps_1.md",
  );
});
