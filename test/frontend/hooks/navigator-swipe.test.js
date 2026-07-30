import test from "node:test";
import assert from "node:assert/strict";

import { attachNavigatorSwipe } from "../../../frontend/src/hooks/navigator-swipe.js";

function fixture() {
  const listeners = new Map();
  return {
    listeners,
    element: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    },
  };
}

function pointerEvent(clientX, clientY, pointerId = 1) {
  return {
    pointerType: "touch",
    pointerId,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
  };
}

test("navigator swipe preserves the browser edge gesture and opens from the page body", () => {
  const { element, listeners } = fixture();
  let opens = 0;
  const detach = attachNavigatorSwipe(element, { onOpen: () => { opens += 1; } });
  listeners.get("pointerdown")(pointerEvent(10, 100));
  listeners.get("pointerup")(pointerEvent(90, 110));
  listeners.get("pointerdown")(pointerEvent(40, 100));
  listeners.get("pointerup")(pointerEvent(150, 100));
  listeners.get("pointerdown")(pointerEvent(80, 100));
  listeners.get("pointermove")(pointerEvent(90, 150));
  listeners.get("pointerup")(pointerEvent(160, 200));
  assert.equal(opens, 1);
  detach();
  assert.equal(listeners.size, 0);
});

test("navigator swipe closes with a leftward horizontal touch while open", () => {
  const { element, listeners } = fixture();
  let closes = 0;
  const detach = attachNavigatorSwipe(element, {
    isOpen: () => true,
    onClose: () => { closes += 1; },
  });
  listeners.get("pointerdown")(pointerEvent(180, 100));
  listeners.get("pointermove")(pointerEvent(100, 106));
  listeners.get("pointerup")(pointerEvent(90, 108));
  assert.equal(closes, 1);
  detach();
});

test("navigator swipe commits before a mobile pointer cancellation", () => {
  const { element, listeners } = fixture();
  let opens = 0;
  const detach = attachNavigatorSwipe(element, { onOpen: () => { opens += 1; } });
  listeners.get("pointerdown")(pointerEvent(40, 100));
  listeners.get("pointermove")(pointerEvent(110, 104));
  listeners.get("pointercancel")(pointerEvent(110, 104));
  assert.equal(opens, 1);
  detach();
});
