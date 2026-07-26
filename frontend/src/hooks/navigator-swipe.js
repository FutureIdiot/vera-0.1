export function attachNavigatorSwipe(element, {
  onOpen,
  onClose,
  isOpen = () => false,
  isEnabled = () => true,
  edgePx = 24,
  thresholdPx = 64,
  intentPx = 10,
  axisRatio = 1.2,
} = {}) {
  let start = null;
  let suppressClick = false;
  let suppressionTimer = null;

  function onPointerDown(event) {
    if (event.pointerType !== "touch" || !isEnabled()) return;
    const open = Boolean(isOpen());
    if (!open && event.clientX > edgePx) return;
    start = {
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      open,
    };
  }

  function onPointerMove(event) {
    if (!start || event.pointerId !== start.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dy) > intentPx && Math.abs(dy) > Math.abs(dx)) {
      start = null;
      return;
    }
    if (Math.abs(dx) > intentPx && Math.abs(dx) > Math.abs(dy) * axisRatio) {
      event.preventDefault();
    }
  }

  function onPointerUp(event) {
    if (!start || event.pointerId !== start.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    const { open } = start;
    start = null;
    const horizontal = Math.abs(dx) > thresholdPx && Math.abs(dx) > dy * axisRatio;
    const committed = horizontal && (open ? dx < 0 : dx > 0);
    if (!committed) return;
    event.preventDefault();
    suppressClick = true;
    clearTimeout(suppressionTimer);
    suppressionTimer = setTimeout(() => { suppressClick = false; }, 0);
    if (open) onClose?.();
    else onOpen?.();
  }

  function onClick(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function cancel() { start = null; }
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("click", onClick, true);
  return () => {
    clearTimeout(suppressionTimer);
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", cancel);
    element.removeEventListener("click", onClick, true);
  };
}
