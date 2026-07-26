import test from "node:test";
import assert from "node:assert/strict";

import { attachSpaceRowTouchActions } from "../../../frontend/src/hooks/space-row-actions.js";

function fixture() {
  const listeners = new Map();
  const classes = new Set();
  let scheduled = null;
  const element = {
    classList: {
      add(value) { classes.add(value); },
      contains(value) { return classes.has(value); },
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const detach = attachSpaceRowTouchActions(element, {
    onReveal() {},
    setTimer(callback) {
      scheduled = callback;
      return 1;
    },
    clearTimer() {
      scheduled = null;
    },
  });
  return {
    classes,
    detach,
    element,
    listeners,
    runTimer() {
      const callback = scheduled;
      callback?.();
    },
  };
}

function pointerEvent({
  pointerType = "touch",
  pointerId = 1,
  clientX = 20,
  clientY = 20,
  action = false,
} = {}) {
  return {
    pointerType,
    pointerId,
    clientX,
    clientY,
    button: 0,
    target: {
      closest() { return action ? {} : null; },
    },
  };
}

function clickEvent() {
  const result = {
    prevented: false,
    stopped: false,
    immediateStopped: false,
  };
  return {
    result,
    event: {
      preventDefault() { result.prevented = true; },
      stopPropagation() { result.stopped = true; },
      stopImmediatePropagation() { result.immediateStopped = true; },
    },
  };
}

test("a short touch leaves actions hidden and keeps row navigation intact", () => {
  const { classes, detach, listeners } = fixture();
  listeners.get("pointerdown")(pointerEvent());
  listeners.get("pointerup")(pointerEvent());
  const click = clickEvent();
  listeners.get("click")(click.event);
  assert.equal(classes.has("is-actions-revealed"), false);
  assert.equal(click.result.prevented, false);
  detach();
  assert.equal(listeners.size, 0);
});

test("a long touch reveals actions and consumes only its synthetic click", () => {
  const { classes, detach, listeners, runTimer } = fixture();
  listeners.get("pointerdown")(pointerEvent());
  runTimer();
  assert.equal(classes.has("is-actions-revealed"), true);

  const syntheticClick = clickEvent();
  listeners.get("click")(syntheticClick.event);
  assert.deepEqual(syntheticClick.result, {
    prevented: true,
    stopped: true,
    immediateStopped: true,
  });

  listeners.get("pointerdown")(pointerEvent({ action: true }));
  const actionClick = clickEvent();
  listeners.get("click")(actionClick.event);
  assert.equal(actionClick.result.prevented, false);
  detach();
});

test("touch movement cancels the long press while mouse input is ignored", () => {
  const { classes, detach, listeners, runTimer } = fixture();
  listeners.get("pointerdown")(pointerEvent());
  listeners.get("pointermove")(pointerEvent({ clientX: 40 }));
  runTimer();
  listeners.get("pointerdown")(pointerEvent({ pointerType: "mouse" }));
  runTimer();
  assert.equal(classes.has("is-actions-revealed"), false);
  detach();
});
