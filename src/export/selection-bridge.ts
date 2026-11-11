/**
 * rosezm - touch long-press drag selection.
 *
 * 
 * Desktop mouse selection is the browser's own; a touch WebView needs a
 * deliberate convention. The bridge:
 *
 *   1. a 500ms long press on TEXT arms selection (never on a button,
 *      link, input or anything `[data-rosezm-no-select]`);
 *   2. the following drag extends a DOM Range from the REAL caret point
 *      under the start (`document.caretRangeFromPoint` / `caretPositionFromPoint`)
 *      to the caret point under the finger - no guessed offsets;
 *   3. the built range is put in window.getSelection() and a cancelable
 *      `rosezm:selection` event reports { text, phase, range } so the
 *      shell can surface its native copy handles;
 *   4. short taps and scrolls (a mostly-vertical move) never arm.
 *
 * A platform without caret APIs reports nothing rather than fabricating a
 * selection. The event is cancelable so an app with its own selection UI
 * can take over.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const SELECTION_BRIDGE_FILE = 'rosezm-selection.js';
const SELECTION_BRIDGE_TAG = `<script src="/${SELECTION_BRIDGE_FILE}" defer></script>`;
const LONG_PRESS_MS = 500;

function selectionBridgeScript(): string {
  return `(function () {
  'use strict';
  var HOLD = ${LONG_PRESS_MS};
  var arm = null, dragging = false;
  function selectable(target) {
    while (target && target !== document.body) {
      if (target.getAttribute && target.getAttribute('data-rosezm-no-select') !== null) return false;
      if (target.tagName && /^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return false;
      target = target.parentElement;
    }
    return true;
  }
  function caret(x, y) {
    try {
      if (typeof document.caretRangeFromPoint === 'function') {
        var r = document.caretRangeFromPoint(x, y);
        if (r) return { node: r.startContainer, offset: r.startOffset };
      }
      if (typeof document.caretPositionFromPoint === 'function') {
        var p = document.caretPositionFromPoint(x, y);
        if (p) return { node: p.offsetNode, offset: p.offset };
      }
    } catch (e) {}
    return null;
  }
  function emit(phase, text, range) {
    var detail = { text: text || '', phase: phase, range: range || null };
    var ev;
    try { ev = new CustomEvent('rosezm:selection', { cancelable: true, detail: detail }); }
    catch (e) { ev = document.createEvent('CustomEvent'); ev.initCustomEvent('rosezm:selection', true, true, detail); }
    document.dispatchEvent(ev);
  }
  function extend(x, y, start) {
    var end = caret(x, y);
    if (!start || !end) return;
    var range;
    try {
      range = document.createRange();
      // caretRangeFromPoint may return either order; setStart/setEnd must
      // follow DOM order or Range throws.
      var cmp = start.node.compareDocumentPosition(end.node);
      var before = cmp === 0 ? start.offset <= end.offset : !!(cmp & 4);
      if (before) { range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); }
      else { range.setStart(end.node, end.offset); range.setEnd(start.node, start.offset); }
      var sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      emit(dragging ? 'change' : 'end', sel && sel.toString ? sel.toString() : '', range);
    } catch (e) {}
  }
  document.addEventListener('touchstart', function (e) {
    var t = e.touches && e.touches[0];
    if (!t || e.touches.length !== 1) { arm = null; return; }
    if (!selectable(e.target)) { arm = null; return; }
    var c = caret(t.clientX, t.clientY);
    arm = { x: t.clientX, y: t.clientY, at: Date.now(), id: t.identifier, caret: c };
    dragging = false;
    try {
      arm.timer = setTimeout(function () {
        if (!arm) return;
        dragging = true;
        emit('start', '', null);
      }, HOLD);
    } catch (err) {}
  }, { passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!arm) return;
    var t = null;
    for (var i = 0; i < e.touches.length; i++) if (e.touches[i].identifier === arm.id) t = e.touches[i];
    if (!t) return;
    var dx = t.clientX - arm.x, dy = t.clientY - arm.y;
    if (!dragging && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      // A scroll, not a hold: disarm (and never select on a scroll).
      try { clearTimeout(arm.timer); } catch (err) {}
      arm = null;
      return;
    }
    if (dragging) extend(t.clientX, t.clientY, arm.caret);
  }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (!arm) return;
    var a = arm;
    arm = null;
    try { clearTimeout(a.timer); } catch (err) {}
    if (!dragging) return;
    var t = null;
    for (var i = 0; i < e.changedTouches.length; i++) if (e.changedTouches[i].identifier === a.id) t = e.changedTouches[i];
    dragging = false; // the final extension must report phase 'end'
    if (t) extend(t.clientX, t.clientY, a.caret);
  }, { passive: true });
  document.addEventListener('touchcancel', function () {
    if (arm) { try { clearTimeout(arm.timer); } catch (e) {} }
    arm = null; dragging = false;
  }, { passive: true });
})();
`;
}

/** Write the selection bridge and tag every document. Idempotent. Returns
 *  the number of documents tagged. */
export async function injectSelectionBridge(site: string): Promise<number> {
  await fs.promises.mkdir(site, { recursive: true });
  await fs.promises.writeFile(path.join(site, SELECTION_BRIDGE_FILE), selectionBridgeScript(), 'utf8');
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(SELECTION_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', `${SELECTION_BRIDGE_TAG}</head>`)
        : SELECTION_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
