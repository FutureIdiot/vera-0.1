import test from "node:test";
import assert from "node:assert/strict";
import { createBubbleSplitter } from "../../src/spaces/bubble-splitter.js";

test("splits on paragraph boundary across multiple feed() calls", () => {
  const splitter = createBubbleSplitter({ boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 1000 });

  let out = splitter.feed("Hello world.\n\nSecond para start");
  assert.deepEqual(out, ["Hello world."]);

  out = splitter.feed(" continues.");
  assert.deepEqual(out, []);

  out = splitter.flush();
  assert.deepEqual(out, ["Second para start continues."]);
});

test("splits multiple paragraphs delivered in one chunk", () => {
  const splitter = createBubbleSplitter({ boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 1000 });
  const out = splitter.feed("para one\n\npara two\n\npara three");
  assert.deepEqual(out, ["para one", "para two"]);
  assert.equal(splitter.peek(), "para three");
  assert.deepEqual(splitter.flush(), ["para three"]);
});

test("forces a split when text exceeds maxLength with no boundary", () => {
  const splitter = createBubbleSplitter({ boundaryPattern: "\\n\\s*\\n", minLength: 1, maxLength: 20 });
  const longText = "word ".repeat(20); // 100 chars, no paragraph boundary
  const out = splitter.feed(longText);
  assert.ok(out.length >= 1, "should force at least one split");
  for (const bubble of out) {
    assert.ok(bubble.length <= 20, `bubble too long: ${bubble.length}`);
  }
});

test("flush() returns nothing when buffer is empty", () => {
  const splitter = createBubbleSplitter();
  splitter.feed("one paragraph only, no boundary");
  const rest = splitter.flush();
  assert.deepEqual(rest, ["one paragraph only, no boundary"]);
  assert.deepEqual(splitter.flush(), []);
});
