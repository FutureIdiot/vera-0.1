const ACTION_SELECTOR = ".vera-space-row__action, .vera-space-row__pin";

export function attachSpaceRowTouchActions(element, {
  onReveal = () => {},
  longPressMs = 500,
  moveTolerancePx = 10,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let timer = null;
  let start = null;
  let suppressClick = false;

  function clearLongPress() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    start = null;
  }

  function reveal() {
    clearLongPress();
    onReveal(element);
    element.classList.add("is-actions-revealed");
    suppressClick = true;
  }

  function onPointerDown(event) {
    suppressClick = false;
    clearLongPress();
    if (
      event.pointerType !== "touch"
      || event.button > 0
      || event.target.closest?.(ACTION_SELECTOR)
    ) return;
    start = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    timer = setTimer(reveal, longPressMs);
  }

  function onPointerMove(event) {
    if (!start || event.pointerId !== start.pointerId) return;
    if (
      Math.abs(event.clientX - start.x) > moveTolerancePx
      || Math.abs(event.clientY - start.y) > moveTolerancePx
    ) clearLongPress();
  }

  function onPointerUp(event) {
    if (!start || event.pointerId !== start.pointerId) return;
    clearLongPress();
  }

  function onPointerCancel() {
    suppressClick = false;
    clearLongPress();
  }

  function onContextMenu(event) {
    if (event.pointerType !== "touch") return;
    event.preventDefault();
    reveal();
  }

  function onClick(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);
  element.addEventListener("contextmenu", onContextMenu);
  element.addEventListener("click", onClick, true);

  return () => {
    clearLongPress();
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerCancel);
    element.removeEventListener("contextmenu", onContextMenu);
    element.removeEventListener("click", onClick, true);
  };
}
