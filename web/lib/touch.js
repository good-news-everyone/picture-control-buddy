// Touch gestures on pointer events (spec/ui-mobile.md "Input", "Common slider row"; plan 2.7).
// Shared by both pages: the gestures are active whenever the pointer is a finger or a pen
// (long-press can be limited by `types`); the mouse keeps the desktop paths (Space, dblclick).
// Every helper works with synthetic PointerEvents (the tests dispatch them) and returns dispose().

const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);

/**
 * Long press: pointerdown arms a timer; moving more than `slop` px or releasing before `delay` ms
 * cancels it; after start() the press ends on pointerup / pointercancel / lostpointercapture
 * (iOS steals the capture during system gestures) and end() is called exactly once.
 * types — the pointer types that can start it (default: all, as in plan 2.7).
 */
export function onLongPress(el, { start, end, delay = 250, slop = 10, types = null } = {}) {
  let id = null, x0 = 0, y0 = 0, timer = 0, active = false;
  const cancel = () => { clearTimeout(timer); timer = 0; id = null; };
  const finish = (e) => {
    if (id === null || (e && e.pointerId !== id)) return;
    const was = active;
    clearTimeout(timer);
    timer = 0; id = null; active = false;
    if (was) end?.(e);
  };
  const onDown = (e) => {
    if (id !== null) return;                                  // a second finger does not restart it
    if (types && !types.includes(e.pointerType)) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; active = false;
    timer = setTimeout(() => {
      timer = 0;
      active = true;
      try { el.setPointerCapture(id); } catch { /* synthetic pointers cannot be captured */ }
      start?.(e);
    }, delay);
  };
  const onMove = (e) => {
    if (id === null || e.pointerId !== id || active) return;  // once started, moving does not matter
    if (dist(x0, y0, e.clientX, e.clientY) > slop) cancel();
  };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
  el.addEventListener("lostpointercapture", finish);
  return () => {
    finish();
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", finish);
    el.removeEventListener("pointercancel", finish);
    el.removeEventListener("lostpointercapture", finish);
  };
}

/**
 * Double tap (touch and pen only; the mouse keeps dblclick): two taps — a tap is a pointerup within
 * `slop` px of its own pointerdown — within `interval` ms and `slop` px of each other call fn(event).
 * A drag is not a tap. Events whose target matches `exclude` are ignored completely.
 */
export function onDoubleTap(el, fn, { interval = 300, slop = 12, exclude = "input[type=number]" } = {}) {
  let down = null;       // {id, x, y} of the pointer that is down
  let last = null;       // {t, x, y} of the previous tap
  const skip = (e) => e.pointerType === "mouse" || (exclude && e.target.closest?.(exclude));
  const onDown = (e) => {
    if (skip(e)) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e) => {
    if (skip(e) || !down || down.id !== e.pointerId) return;
    const d = down;
    down = null;
    if (dist(d.x, d.y, e.clientX, e.clientY) > slop) { last = null; return; }   // a drag, not a tap
    const now = performance.now();
    if (last && now - last.t <= interval && dist(last.x, last.y, e.clientX, e.clientY) <= slop) {
      last = null;
      fn(e);
    } else {
      last = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  const onCancel = () => { down = null; last = null; };
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  return () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
  };
}

/**
 * Horizontal drag for a range input whose native touch handling is switched off (CSS
 * `pointer-events: none` on the input; the gesture area is its row). Chromium's native range jumps
 * to the touch point on touchstart, so a vertical swipe that starts on the track changes the value
 * and a tap on the track moves it. Here a touch changes the value only after it has moved
 * `threshold` px with |dx| > |dy|; a mostly vertical move is left to the browser (it scrolls the
 * panel, pointercancel follows) and a plain tap changes nothing. A drag that starts near the thumb
 * keeps the thumb under the finger; elsewhere on the track the thumb follows the finger from the
 * moment the threshold is passed. A mouse behaves like the native range (the value follows the
 * pointer from pointerdown). `input` events fire during the drag, one `change` at the end if the
 * value changed — as a native drag does.
 * The area needs `touch-action: pan-y` (horizontal moves must stay with the page).
 * options: area — the element that receives the pointer events (default: the input's parent);
 * exclude — selector of sub-elements that do not start a drag (label and number field: ".top");
 * thumb — the thumb width in px (the thumb center travels width - thumb).
 */
export function horizontalDrag(range, { threshold = 8, area = range.parentElement, exclude = ".top", thumb = 22 } = {}) {
  let st = null;   // {id, x0, y0, v0, dx, dragging}
  const frac = () => (range.value - range.min) / ((range.max - range.min) || 1);
  const rect = () => range.getBoundingClientRect();
  function setFromX(x) {
    const r = rect();
    const span = Math.max(1, r.width - thumb);
    const f = Math.min(1, Math.max(0, (x + st.dx - r.left - thumb / 2) / span));
    const before = range.value;
    range.value = String(parseFloat(range.min) + f * (range.max - range.min));   // the browser snaps to step
    if (range.value !== before) range.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function begin(e) {
    st.dragging = true;
    const r = rect();
    const thumbX = r.left + thumb / 2 + frac() * Math.max(1, r.width - thumb);
    st.dx = e.pointerType !== "mouse" && Math.abs(st.x0 - thumbX) <= thumb ? thumbX - st.x0 : 0;
    try { area.setPointerCapture(st.id); } catch { /* synthetic pointers cannot be captured */ }
    if (e.pointerType === "mouse") try { range.focus({ preventScroll: true }); } catch { /* ignore */ }
    setFromX(e.clientX);
  }
  function finish(commit) {
    const s = st;
    st = null;
    if (s?.dragging && commit !== false && range.value !== s.v0) range.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const onDown = (e) => {
    if (st || range.disabled) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (exclude && e.target.closest?.(exclude)) return;
    st = { id: e.pointerId, x0: e.clientX, y0: e.clientY, v0: range.value, dx: 0, dragging: false };
    if (e.pointerType === "mouse") { begin(e); e.preventDefault(); }
  };
  const onMove = (e) => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.dragging) {
      const dx = e.clientX - st.x0, dy = e.clientY - st.y0;
      if (Math.hypot(dx, dy) < threshold) return;
      if (Math.abs(dx) > Math.abs(dy)) begin(e);
      else st = null;                          // a vertical gesture: the browser scrolls, nothing changes
      return;
    }
    setFromX(e.clientX);
  };
  const onUp = (e) => { if (st && e.pointerId === st.id) finish(true); };
  const onCancel = (e) => { if (st && e.pointerId === st.id) finish(true); };
  area.addEventListener("pointerdown", onDown);
  area.addEventListener("pointermove", onMove);
  area.addEventListener("pointerup", onUp);
  area.addEventListener("pointercancel", onCancel);
  return () => {
    st = null;
    area.removeEventListener("pointerdown", onDown);
    area.removeEventListener("pointermove", onMove);
    area.removeEventListener("pointerup", onUp);
    area.removeEventListener("pointercancel", onCancel);
  };
}
