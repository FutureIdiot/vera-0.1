export function attachEdgeSwipe(element, onOpen, { edgePx = 24, thresholdPx = 64 } = {}) {
  let start = null;
  function onPointerDown(event) {
    if (event.pointerType !== "touch" || event.clientX > edgePx) return;
    start = { x: event.clientX, y: event.clientY };
  }
  function onPointerUp(event) {
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = Math.abs(event.clientY - start.y);
    start = null;
    if (dx > thresholdPx && dx > dy * 1.2) onOpen?.();
  }
  function cancel() { start = null; }
  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", cancel);
  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", cancel);
  };
}
