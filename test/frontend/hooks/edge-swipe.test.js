import test from "node:test";
import assert from "node:assert/strict";

import { attachEdgeSwipe } from "../../../frontend/src/hooks/edge-swipe.js";

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

test("edge swipe opens only for a rightward horizontal touch from the edge", () => {
  const { element, listeners } = fixture();
  let opens = 0;
  const detach = attachEdgeSwipe(element, () => { opens += 1; });
  listeners.get("pointerdown")({ pointerType: "touch", clientX: 10, clientY: 100 });
  listeners.get("pointerup")({ clientX: 90, clientY: 110 });
  listeners.get("pointerdown")({ pointerType: "touch", clientX: 40, clientY: 100 });
  listeners.get("pointerup")({ clientX: 150, clientY: 100 });
  listeners.get("pointerdown")({ pointerType: "touch", clientX: 10, clientY: 100 });
  listeners.get("pointerup")({ clientX: 90, clientY: 200 });
  assert.equal(opens, 1);
  detach();
  assert.equal(listeners.size, 0);
});
