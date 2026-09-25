/**
 * doc-review artifact SDK.
 *
 * Runs inside the sandboxed iframe alongside the artifact. It owns the
 * document: editing, highlights, target resolution and serialization. It never
 * talks to the server — everything crosses to the chrome page by postMessage.
 */
import { buildContext, findQuote, resolveQuote } from "./anchor-text.js";
import { createThreadAnchorController } from "./thread-anchor-controller.js";
import { hashClickAction, navigationHref } from "./click-target.js";
import { acceptedOpenGeneration, createHoverIntent, groupCommentTargets, nextCommentId, normalizeSelectionRange, pointInCommentApproach, sameRange, sameThreadTarget, targetMessage } from "./comment-target.js";
import { classifyHref, externalHref, linkStyleFixup, listCommandFor, listStyleFixup, normalizeHref } from "./editing.js";
import { frameMessage, initializeChannelFromDocument, matchesFrameMessage } from "./frame-channel.js";
import { iconMarkup } from "./icons.js";
import { keepBodyInReviewMode } from "./review-mode.js";
import { captureSemanticSnapshot } from "./semantic-snapshot.js";
import { serializeDocument, UI_ATTR, MARK_ATTR } from "./serialize.js";
import { observeView, sameObservedView } from "./view-identity.js";

initializeChannelFromDocument();

const SAVE_DEBOUNCE_MS = 700;
const EDIT_FLUSH_MS = 500;
const CAPTURE_READY_TIMEOUT_MS = 2500;
const CAPTURE_STABLE_MS = 300;
const MEDIA = /^(img|svg|canvas|video|picture|iframe|hr|figure)$/i;

// The chrome page lives on the other loopback hostname (a separate origin, so
// the reviewed document can never touch it directly). Address it explicitly so
// nothing we post can be read by any other embedder.
const CHROME_ORIGIN = `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`;

const post = (type, payload) => parent.postMessage(frameMessage(type, payload), CHROME_ORIGIN);

let pending = null; // semantic target plus cloned range/element until commit or cancel
let retarget = null;
let targetGeneration = 0;
let targetObserver = null;
let targetIntersection = null;
let reviewMode = "view";
let savePolicy = "writable";
let modeController = null;
let hoverTarget = null;
let hoverMove = null; // the innermost block under the cursor, movable via the handle
let hoverMedia = null; // the img/video under the cursor, resizable via the grip
let resizing = null; // live drag state while the grip is held
let suppressUntil = 0; // ignore the mouseup/click that ends a resize drag
let saveTimer = null;
let composeOpen = false;
let retiredComposeGeneration = 0;
let commentOpenRequestGeneration = null;
let activeCommentId = null;
let modeMenuOpen = false;
let lastTargetGeometrySignature = "";
let lastTargetRelation = null;
let geometryWatchTimer = null;
let watchedGeometrySignature = "";
let selectionTimer = null;
let hoverIntent = null;
let pointerSelecting = false;
let composing = false;
let disposed = false;
let viewObserver = null;
let viewChangeTimer = null;
let lastObservedView = null;
let reviewTheme = null;
let themeRevision = 0;
let themeWarnings = 0;
const blockTargets = new Map();
const blockMarkers = new Map();
let threadAnchors = null;
const threadTargets = new Map();
/** True when the page's own scripts rewrote the DOM before any user edit. */
let dynamic = false;

const diagnostic = (event, detail = {}) => {
  console.info("[doc-review-frame]", { event, ...detail });
};

// ------------------------------------------------------------------ overlay

const host = document.createElement("div");
host.setAttribute(UI_ATTR, "");
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = `
  <style>
    :host { all: initial; }
    :host(:not([data-review-theme])) { visibility: hidden !important; }
    :host(:not([data-review-theme])) * { visibility: hidden !important; pointer-events: none !important; }
    /* REVIEW_THEME_SHADOW_START */
    :host([data-review-theme="light"]) {
      color-scheme: light;
      --review-background: #F5F2EA;
      --review-foreground: #292E2B;
      --review-card: #FFFDF7;
      --review-card-foreground: #292E2B;
      --review-popover: #FFFDF7;
      --review-popover-foreground: #292E2B;
      --review-primary: #17685F;
      --review-primary-foreground: #FFFDF7;
      --review-secondary: #ECEDE5;
      --review-secondary-foreground: #626B65;
      --review-muted: #ECEDE5;
      --review-muted-foreground: #626B65;
      --review-accent: #E1EEEA;
      --review-accent-foreground: #17685F;
      --review-destructive: #B43C48;
      --review-destructive-foreground: #FFFDF7;
      --review-border: #D8D8CC;
      --review-input: #7C877D;
      --review-ring: #17685F;
      --review-review-added: #EFF3E2;
      --review-review-added-foreground: #4D6B24;
      --review-review-added-border: #82945E;
      --review-review-removed: #FCECEF;
      --review-review-removed-foreground: #B43C48;
      --review-review-removed-border: #C88791;
      --review-review-modified: #FFF1D9;
      --review-review-modified-foreground: #915B13;
      --review-review-modified-border: #B99157;
      --review-review-count-added: #4D6B24;
      --review-review-count-removed: #B43C48;
      --review-review-count-modified: #915B13;
      --review-review-insert: #DCE7C5;
      --review-review-delete: #FAE2E7;
      --review-review-overlay: #191F1D80;
      --review-review-shadow-color: #191F1D26;
      --review-annotation-foreground: #75470E;
      --review-annotation-background: #FFF1D9;
      --review-annotation-active: #F5D6A3;
      --review-annotation-border: #915B13;
      --review-annotation-tint: #915B131A;
      --review-annotation-active-tint: #915B132E;
      --review-halo-light: #FFFDF7;
      --review-halo-dark: #191F1D;
    }
    :host([data-review-theme="dark"]) {
      color-scheme: dark;
      --review-background: #191F1D;
      --review-foreground: #EEEFE6;
      --review-card: #222A26;
      --review-card-foreground: #EEEFE6;
      --review-popover: #222A26;
      --review-popover-foreground: #EEEFE6;
      --review-primary: #85C7B8;
      --review-primary-foreground: #102F29;
      --review-secondary: #303A33;
      --review-secondary-foreground: #AFB9AF;
      --review-muted: #303A33;
      --review-muted-foreground: #AFB9AF;
      --review-accent: #293F37;
      --review-accent-foreground: #85C7B8;
      --review-destructive: #F2A2AB;
      --review-destructive-foreground: #40272C;
      --review-border: #3C4841;
      --review-input: #77877B;
      --review-ring: #85C7B8;
      --review-review-added: #2B3522;
      --review-review-added-foreground: #BBCD87;
      --review-review-added-border: #6F8347;
      --review-review-removed: #40272C;
      --review-review-removed-foreground: #F2A2AB;
      --review-review-removed-border: #A96572;
      --review-review-modified: #3D3020;
      --review-review-modified-foreground: #E7BB72;
      --review-review-modified-border: #9C7A46;
      --review-review-count-added: #BBCD87;
      --review-review-count-removed: #F2A2AB;
      --review-review-count-modified: #E7BB72;
      --review-review-insert: #3E4D2D;
      --review-review-delete: #633944;
      --review-review-overlay: #191F1DB3;
      --review-review-shadow-color: #00000066;
      --review-annotation-foreground: #F1CC8E;
      --review-annotation-background: #3D3020;
      --review-annotation-active: #594325;
      --review-annotation-border: #E7BB72;
      --review-annotation-tint: #E7BB721A;
      --review-annotation-active-tint: #E7BB722E;
      --review-halo-light: #FFFDF7;
      --review-halo-dark: #191F1D;
    }
/* REVIEW_THEME_SHADOW_END */
    .box { position: fixed; pointer-events: none; z-index: 2147483646; border-radius: 3px; display: none; }
    .outline { border: 1px dashed var(--review-input); animation: outline-in 90ms ease-out; }
    @keyframes outline-in { from { opacity: .2; } to { opacity: 1; } }
    .active { border: 2px solid var(--review-annotation-border); }
    .block-marker { position: fixed; pointer-events: none; z-index: 2147483644;
      box-sizing: border-box; border-left: 3px solid var(--review-annotation-border); background: var(--review-annotation-tint); }
    .block-marker[data-active="true"] { border-left-width: 6px; background: var(--review-annotation-active-tint); }
    .block-badge { position: fixed; z-index: 2147483647; pointer-events: auto;
      height: 24px; min-width: 32px; box-sizing: border-box; padding: 2px 6px;
      border: 1px solid var(--review-annotation-border); border-radius: 5px; background: var(--review-annotation-background); color: var(--review-annotation-foreground);
      font: 600 12px/18px system-ui, sans-serif; cursor: pointer; }
    .block-badge[aria-pressed="true"] { border-width: 2px; text-decoration: underline; }
    .block-badge:focus-visible { outline: 3px solid var(--review-ring); outline-offset: 2px; }
    .chips {
      position: fixed; z-index: 2147483647; display: none; gap: 4px;
      pointer-events: auto;
    }
    .chip {
      width: 23px; height: 23px; display: flex;
      align-items: center; justify-content: center; padding: 0;
      border: 1px solid var(--review-input); border-radius: 50%; background: var(--review-card); color: var(--review-muted-foreground);
      font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .chip:hover { background: var(--review-accent); color: var(--review-accent-foreground); border-color: var(--review-primary); }
    .chip.danger { color: var(--review-destructive); }
    .chip.danger:hover { background: var(--review-destructive); color: var(--review-destructive-foreground); border-color: var(--review-destructive); }
    .chips .chip, .mover { transition: background-color 100ms ease; }
    button:disabled { background: var(--review-muted); color: var(--review-muted-foreground); cursor: not-allowed; }
    .grip {
      position: fixed; z-index: 2147483647; width: 13px; height: 13px;
      display: none; border: 1px solid var(--review-primary); border-radius: 3px;
      background: var(--review-card); cursor: nwse-resize; pointer-events: auto;
    }
    .hint {
      position: fixed; z-index: 2147483647; display: none; padding: 3px 7px;
      border-radius: 5px; background: var(--review-card); color: var(--review-foreground); white-space: nowrap;
      font: 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }
    .linkbox {
      position: fixed; z-index: 2147483647; display: none; gap: 4px; align-items: center;
      padding: 5px; border: 1px solid var(--review-input); border-radius: 9px; background: var(--review-card);
      pointer-events: auto;
    }
    .linkbox input {
      width: 224px; padding: 4px 7px; border: none; outline: none; background: none;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--review-foreground);
    }
    .linkbox input::placeholder { color: var(--review-muted-foreground); opacity: 1; }
    .mover {
      position: fixed; z-index: 2147483647; width: 18px; height: 24px;
      display: none; align-items: center; justify-content: center;
      border: 1px solid var(--review-input); border-radius: 6px; background: var(--review-card); color: var(--review-muted-foreground);
      font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      cursor: grab; pointer-events: auto; user-select: none;
    }
    .mover:hover { color: var(--review-accent-foreground); background: var(--review-accent); border-color: var(--review-primary); }
    .mover:active { cursor: grabbing; }
    .dropline {
      position: fixed; z-index: 2147483646; height: 0; display: none;
      border-top: 2px solid var(--review-primary); border-radius: 1px; pointer-events: none;
    }
    .comment-action {
      position: fixed; z-index: 2147483647; width: 30px; height: 30px;
      display: none; align-items: center; justify-content: center; padding: 0;
      border: 1px solid var(--review-primary); border-radius: 999px; background: var(--review-primary); color: var(--review-primary-foreground);
      cursor: pointer; pointer-events: auto;
    }
    .comment-action:hover { background: var(--review-accent); color: var(--review-accent-foreground); }
    button:focus-visible, input:focus-visible, .mover:focus-visible, .grip:focus-visible {
      outline: 3px solid var(--review-ring); outline-offset: 2px;
    }
    .box, .block-marker, .block-badge, .chip, .grip, .hint, .linkbox, .mover, .dropline, .comment-action {
      box-shadow: 0 0 0 1px var(--review-halo-light), 0 0 0 2px var(--review-halo-dark), 0 3px 10px var(--review-review-shadow-color);
    }
    .selection-cues { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
    .selection-cue { position: fixed; border-radius: 2px; background: var(--review-annotation-tint);
      box-shadow: inset 0 -2px var(--review-annotation-border), 0 1px var(--review-halo-light), 0 2px var(--review-halo-dark); }
    ::selection { background: var(--review-annotation-active); color: var(--review-annotation-foreground); }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
  </style>
  <div class="box outline" id="outline"></div>
  <div class="box active" id="activeBox"></div>
  <div class="chips" id="chips">
    <button class="chip danger" id="chipDelete" title="Delete this block" aria-label="Delete this block">${iconMarkup("trash", { size: 14 })}</button>
  </div>
  <div class="grip" id="grip" title="Drag to resize"></div>
  <div class="hint" id="hint"></div>
  <div class="linkbox" id="linkbox">
    <input id="linkInput" type="text" placeholder="Link to&hellip;" spellcheck="false">
    <button class="chip" id="linkApply" title="Apply link" aria-label="Apply link">${iconMarkup("check", { size: 14 })}</button>
    <button class="chip danger" id="linkRemove" title="Remove link" aria-label="Remove link">${iconMarkup("x", { size: 14 })}</button>
  </div>
  <div class="mover" id="mover" title="Drag to move this block">&#10303;</div>
  <div class="dropline" id="dropline"></div>
  <div class="selection-cues" id="selectionCues"></div>
  <div id="blockAnnotations" role="group" aria-label="Saved block comments"></div>
  <button class="comment-action" id="commentAction" title="Comment on this target" aria-label="Comment on this target">${iconMarkup("messageSquarePlus", { size: 17 })}</button>
`;

const els = {};
const mountOverlay = () => {
  if (!host.isConnected) document.documentElement.appendChild(host);
  els.outline = shadow.getElementById("outline");
  els.activeBox = shadow.getElementById("activeBox");
  els.chips = shadow.getElementById("chips");
  els.chipDelete = shadow.getElementById("chipDelete");
  els.grip = shadow.getElementById("grip");
  els.hint = shadow.getElementById("hint");
  els.linkbox = shadow.getElementById("linkbox");
  els.linkInput = shadow.getElementById("linkInput");
  els.linkApply = shadow.getElementById("linkApply");
  els.linkRemove = shadow.getElementById("linkRemove");
  els.mover = shadow.getElementById("mover");
  els.dropline = shadow.getElementById("dropline");
  els.selectionCues = shadow.getElementById("selectionCues");
  els.commentAction = shadow.getElementById("commentAction");
  els.blockAnnotations = shadow.getElementById("blockAnnotations");
};

function positionBlockBadge(badge, rect) {
  const width = badge.offsetWidth || 36;
  const height = 24;
  const candidates = [
    [rect.left - width - 5, rect.top], [rect.right + 5, rect.top],
    [rect.right - width, rect.top - height - 5], [rect.right - width, rect.bottom + 5],
    [innerWidth - width - 4, Math.max(4, Math.min(innerHeight - height - 4, rect.top))],
    [4, Math.max(4, Math.min(innerHeight - height - 4, rect.top))],
  ];
  const controls = "a[href], button, input, select, textarea, summary, [role=button], [role=tab], [contenteditable=true]";
  const occupied = [...blockMarkers.values()].filter((entry) => entry.badge !== badge && entry.badge.style.display !== "none")
    .map((entry) => entry.badge.getBoundingClientRect());
  for (const [x, y] of candidates) {
    if (x < 2 || y < 2 || x + width > innerWidth - 2 || y + height > innerHeight - 2) continue;
    if (occupied.some((other) => x < other.right && x + width > other.left && y < other.bottom && y + height > other.top)) continue;
    const blocked = [[x, y], [x + width / 2, y + height / 2], [x + width, y + height], [x, y + height], [x + width, y]]
      .some(([left, top]) => document.elementsFromPoint(left, top).some((element) =>
        !isOurs(element) && element !== document.body && element.closest(controls) !== document.body && element.closest(controls)));
    if (blocked) continue;
    badge.style.left = `${x}px`;
    badge.style.top = `${y}px`;
    badge.style.display = "block";
    return;
  }
  // Never cover an authored control; the drawer remains an accessible fallback.
  badge.style.display = "none";
}

function renderBlockAnnotations() {
  if (!els.blockAnnotations || disposed) return;
  const groups = groupCommentTargets(blockTargets);
  for (const [element, entry] of blockMarkers) {
    if (groups.has(element)) continue;
    entry.marker.remove();
    entry.badge.remove();
    blockMarkers.delete(element);
  }
  for (const [element, ids] of groups) {
    let entry = blockMarkers.get(element);
    if (!entry) {
      const marker = document.createElement("div");
      marker.className = "block-marker";
      marker.setAttribute("aria-hidden", "true");
      const badge = document.createElement("button");
      badge.className = "block-badge";
      badge.type = "button";
      badge.addEventListener("pointerdown", (event) => event.stopPropagation());
      badge.addEventListener("click", (event) => {
        event.stopPropagation();
        hoverIntent?.cancel();
        const currentIds = groupCommentTargets(blockTargets).get(element) || [];
        const id = nextCommentId(currentIds, activeCommentId);
        if (id) requestThreadActivation(id);
      });
      els.blockAnnotations.append(marker, badge);
      entry = { marker, badge };
      blockMarkers.set(element, entry);
    }
    const { marker, badge } = entry;
    const active = ids.includes(activeCommentId);
    marker.dataset.active = String(active);
    badge.setAttribute("aria-pressed", String(active));
    const label = commentTargetFor(element)?.label || element.tagName.toLowerCase();
    const name = ids.length > 1 ? `Open ${ids.length} conversations` : "Open conversation";
    badge.setAttribute("aria-label", name);
    badge.title = `${name} on ${label}`;
    badge.textContent = `◧ ${ids.length}`;
    const rect = visibleRects([rectData(element.getBoundingClientRect())], { kind: "element", element })[0];
    marker.style.display = badge.style.display = "none";
    if (!rect) continue;
    Object.assign(marker.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    positionBlockBadge(badge, rect);
  }
  if (pending || retarget) positionCommentAction(targetRects(retarget || pending));
  refreshGeometryWatch();
}

function showMover(el) {
  if (!el || !el.isConnected) {
    els.mover.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    els.mover.style.display = "none";
    return;
  }
  els.mover.style.display = "flex";
  // Half-overlap the block's edge: the pointer can travel from text to handle
  // without ever leaving the block, so the hover state never drops.
  els.mover.style.left = `${Math.max(4, r.left - 9)}px`;
  els.mover.style.top = `${Math.max(4, r.top + 1)}px`;
}

function showDropline(drop) {
  if (!drop || !drop.ref.isConnected) {
    els.dropline.style.display = "none";
    return;
  }
  const r = drop.ref.getBoundingClientRect();
  els.dropline.style.display = "block";
  els.dropline.style.left = `${r.left}px`;
  els.dropline.style.width = `${r.width}px`;
  els.dropline.style.top = `${(drop.before ? r.top : r.bottom) - 1}px`;
}

function place(box, el, pad = 2) {
  if (!el || !el.isConnected) {
    box.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.style.left = `${r.left - pad}px`;
  box.style.top = `${r.top - pad}px`;
  box.style.width = `${r.width + pad * 2}px`;
  box.style.height = `${r.height + pad * 2}px`;
}

function showChip(el) {
  if (!el || !el.isConnected) {
    els.chips.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  // A target in a collapsed tab has no box; don't strand the chips in a corner.
  if (!r.width && !r.height) {
    els.chips.style.display = "none";
    return;
  }
  els.chips.style.display = "flex";
  els.chips.style.left = `${Math.max(4, r.right - 11)}px`;
  els.chips.style.top = `${Math.max(4, r.top - 11)}px`;
}

function showGrip(el) {
  if (!el || !el.isConnected) {
    els.grip.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    els.grip.style.display = "none";
    return;
  }
  els.grip.style.display = "block";
  els.grip.style.left = `${r.right - 7}px`;
  els.grip.style.top = `${r.bottom - 7}px`;
}

function showHint(text, x, y) {
  if (!text) {
    els.hint.style.display = "none";
    return;
  }
  els.hint.textContent = text;
  els.hint.style.display = "block";
  els.hint.style.left = `${x + 12}px`;
  els.hint.style.top = `${y + 16}px`;
}

const rectData = (rect) => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  width: rect.width,
  height: rect.height,
});

const viewportData = () => ({ width: window.innerWidth, height: window.innerHeight });

function intersectRects(one, two) {
  const left = Math.max(one.left, two.left);
  const top = Math.max(one.top, two.top);
  const right = Math.min(one.right, two.right);
  const bottom = Math.min(one.bottom, two.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function targetRects(target = pending) {
  if (!target) return [];
  if (target.kind === "selection" && target.range) {
    return [...target.range.getClientRects()].map(rectData);
  }
  if (target.element?.isConnected) return [rectData(target.element.getBoundingClientRect())];
  return [];
}

function targetElement(target) {
  if (!target) return null;
  if (target.kind === "element") return target.element || null;
  const node = target.range?.commonAncestorContainer;
  return node?.nodeType === 1 ? node : node?.parentElement || null;
}

function targetConnected(target) {
  if (!target) return false;
  if (target.kind === "element") return !!target.element?.isConnected;
  const range = target.range;
  return !!(
    range &&
    document.body.contains(range.startContainer) &&
    document.body.contains(range.endContainer)
  );
}

function clippingStartNode(target) {
  const element = targetElement(target);
  return target?.kind === "selection" ? element : element?.parentElement;
}

function effectiveClipRect(target) {
  let clip = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  let node = clippingStartNode(target);
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const clipsX = /(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX}`);
    const clipsY = /(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`);
    if (clipsX || clipsY) {
      const rect = node.getBoundingClientRect();
      const ancestorClip = {
        left: clipsX ? rect.left + node.clientLeft : clip.left,
        right: clipsX ? rect.left + node.clientLeft + node.clientWidth : clip.right,
        top: clipsY ? rect.top + node.clientTop : clip.top,
        bottom: clipsY ? rect.top + node.clientTop + node.clientHeight : clip.bottom,
      };
      ancestorClip.width = ancestorClip.right - ancestorClip.left;
      ancestorClip.height = ancestorClip.bottom - ancestorClip.top;
      clip = intersectRects(clip, ancestorClip);
      if (!clip) return null;
    }
    node = node.parentElement;
  }
  return clip;
}

function targetGeometry(target = pending) {
  const clip = effectiveClipRect(target);
  const rects = targetRects(target).filter((rect) =>
    ["left", "top", "right", "bottom", "width", "height"].every((key) => Number.isFinite(rect[key])) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
  if (!targetConnected(target) || !clip || !rects.length) {
    return { relation: "unavailable", clip: clip || {
      left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight,
    }, rects: [], horizontal: target?.horizontal ?? null, rejected: targetConnected(target) ? "invalid" : "disconnected" };
  }
  if (rects.some((rect) => rect.left < clip.left - 1 || rect.right > clip.right + 1)) {
    return { relation: "unavailable", clip, rects: [], horizontal: target?.horizontal ?? null, rejected: "horizontally-clipped" };
  }
  if (rects.every((rect) => rect.bottom <= clip.top)) {
    return { relation: "above", clip, rects: [], horizontal: target?.horizontal ?? null };
  }
  if (rects.every((rect) => rect.top >= clip.bottom)) {
    return { relation: "below", clip, rects: [], horizontal: target?.horizontal ?? null };
  }
  const visible = rects.map((rect) => intersectRects(rect, clip)).filter(Boolean);
  if (!visible.length) {
    return { relation: "unavailable", clip, rects: [], horizontal: target?.horizontal ?? null, rejected: "unavailable" };
  }
  const attached = visible[visible.length - 1];
  target.horizontal = attached.right;
  return { relation: "visible", clip, rects: visible, horizontal: target.horizontal };
}

function rectVisibleThroughAncestors(rect, target) {
  const viewport = viewportData();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    rect.right <= 0 ||
    rect.bottom <= 0 ||
    rect.left >= viewport.width ||
    rect.top >= viewport.height
  ) return false;
  let node = clippingStartNode(target);
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
      const clip = node.getBoundingClientRect();
      if (rect.right <= clip.left || rect.left >= clip.right || rect.bottom <= clip.top || rect.top >= clip.bottom) {
        return false;
      }
    }
    node = node.parentElement;
  }
  return true;
}

function visibleRects(rects, target = pending) {
  return rects.filter((rect) => rectVisibleThroughAncestors(rect, target));
}

function renderSelectionCues(rects) {
  els.selectionCues.textContent = "";
  if (!composeOpen || !pending || pending.kind !== "selection") return;
  for (const rect of visibleRects(rects, pending)) {
    const cue = document.createElement("span");
    cue.className = "selection-cue";
    cue.style.left = `${rect.left}px`;
    cue.style.top = `${rect.top}px`;
    cue.style.width = `${rect.width}px`;
    cue.style.height = `${rect.height}px`;
    els.selectionCues.append(cue);
  }
}

function positionCommentAction(rects, target = retarget || pending) {
  const visible = visibleRects(rects, target);
  const rect = visible[visible.length - 1];
  if (!rect || (composeOpen && !retarget)) {
    els.commentAction.style.display = "none";
    return false;
  }
  const x = Math.max(4, Math.min(window.innerWidth - 34, rect.right + 6));
  const y = Math.max(4, Math.min(window.innerHeight - 34, rect.top - 4));
  const badges = [...blockMarkers.values()].filter(({ badge }) => badge.style.display !== "none")
    .map(({ badge }) => badge.getBoundingClientRect());
  const position = [[x, y], [x, y + 38], [x, y - 38], [x - 38, y]].find(([left, top]) =>
    left >= 4 && top >= 4 && left + 30 <= innerWidth - 4 && top + 30 <= innerHeight - 4 &&
    !badges.some((badge) => left < badge.right && left + 30 > badge.left && top < badge.bottom && top + 30 > badge.top));
  if (!position) { els.commentAction.style.display = "none"; return false; }
  els.commentAction.style.display = "flex";
  els.commentAction.style.left = `${position[0]}px`;
  els.commentAction.style.top = `${position[1]}px`;
  return true;
}

function postTarget(type, target = pending) {
  if (!target) return;
  const geometry = targetGeometry(target);
  const message = targetMessage(
    {
      kind: target.kind,
      quote: target.quote,
      anchor: target.anchor,
      rects: geometry.rects,
      generation: target.generation,
      relation: geometry.relation,
      clip: geometry.clip,
      horizontal: geometry.horizontal,
    },
    viewportData()
  );
  if (!message) return;
  const signature = JSON.stringify({
    generation: message.generation,
    relation: message.relation,
    clip: message.clip,
    rects: message.rects,
    horizontal: message.horizontal,
  });
  if (type !== "eh:openComment" && signature === lastTargetGeometrySignature) return;
  if (type !== "eh:openComment") lastTargetGeometrySignature = signature;
  if (lastTargetRelation !== message.relation) {
    diagnostic("anchor-relation-transition", {
      from: lastTargetRelation,
      to: message.relation,
      targetGeneration: message.generation,
    });
    lastTargetRelation = message.relation;
  }
  if (geometry.rejected) {
    diagnostic("geometry-rejected", {
      reason: geometry.rejected,
      targetGeneration: message.generation,
    });
  }
  post(type, {
    kind: message.kind,
    quote: message.quote,
    anchor: message.anchor,
    rects: message.rects,
    targetGeneration: message.generation,
    relation: message.relation,
    clip: message.clip,
    horizontal: message.horizontal,
    viewport: viewportData(),
  });
}

function disconnectTargetObservers() {
  targetObserver?.disconnect();
  targetIntersection?.disconnect();
  targetObserver = null;
  targetIntersection = null;
}

const roundedGeometry = (value) => Number.isFinite(value) ? Math.round(value * 2) / 2 : null;

function geometryWatchSignature() {
  const target = retarget || pending;
  const targetState = target ? targetGeometry(target) : null;
  let activeState = null;
  if (activeCommentId) {
    const marks = marksFor(activeCommentId);
    const element = marks[0] || blockTargets.get(activeCommentId);
    if (element) {
      const rects = marks.length
        ? marks.map((mark) => rectData(mark.getBoundingClientRect()))
        : [rectData(element.getBoundingClientRect())];
      activeState = {
        rects,
        clip: effectiveClipRect({ kind: "element", element }),
      };
    }
  }
  const normalize = (state) => state && {
    relation: state.relation,
    rects: (state.rects || []).map((rect) => [
      roundedGeometry(rect.left),
      roundedGeometry(rect.top),
      roundedGeometry(rect.right),
      roundedGeometry(rect.bottom),
    ]),
    clip: state.clip && [
      roundedGeometry(state.clip.left),
      roundedGeometry(state.clip.top),
      roundedGeometry(state.clip.right),
      roundedGeometry(state.clip.bottom),
    ],
  };
  return JSON.stringify({
    target: normalize(targetState),
    active: normalize(activeState),
    blocks: [...groupCommentTargets(blockTargets).keys()].map((element) => {
      const rect = element.getBoundingClientRect();
      const clip = effectiveClipRect({ kind: "element", element });
      return [rect.left, rect.top, rect.width, rect.height, clip];
    }),
  });
}

function refreshGeometryWatch() {
  const shouldWatch = !disposed && !!(pending || retarget || activeCommentId || blockTargets.size || threadAnchors?.projection?.anchors.length);
  if (!shouldWatch) {
    clearInterval(geometryWatchTimer);
    geometryWatchTimer = null;
    watchedGeometrySignature = "";
    return;
  }
  if (geometryWatchTimer) return;
  watchedGeometrySignature = geometryWatchSignature();
  geometryWatchTimer = setInterval(() => {
    if (disposed || !(pending || retarget || activeCommentId || blockTargets.size || threadAnchors?.projection?.anchors.length)) {
      refreshGeometryWatch();
      return;
    }
    if (threadAnchors?.projection) {
      try { threadAnchors.refresh(); }
      catch (error) { diagnostic("thread-boundary-rejected", { message: error.message }); }
    }
    const next = geometryWatchSignature();
    if (next === watchedGeometrySignature) return;
    watchedGeometrySignature = next;
    scheduleTargetGeometry();
    renderBlockAnnotations();
    if (activeCommentId) activate(activeCommentId, false);
  }, 100);
}

function observePendingTarget(target = pending) {
  disconnectTargetObservers();
  if (!target) return;
  const observed = target.kind === "element"
    ? target.element
    : target.range?.commonAncestorContainer?.nodeType === 1
      ? target.range.commonAncestorContainer
      : target.range?.commonAncestorContainer?.parentElement;
  if (!observed) return;
  if ("ResizeObserver" in window) {
    targetObserver = new ResizeObserver(scheduleTargetGeometry);
    targetObserver.observe(observed);
  }
  if ("IntersectionObserver" in window) {
    targetIntersection = new IntersectionObserver(scheduleTargetGeometry, { threshold: [0, .01, 1] });
    targetIntersection.observe(observed);
  }
  refreshGeometryWatch();
}

let targetGeometryQueued = false;
function scheduleTargetGeometry() {
  if (targetGeometryQueued) return;
  targetGeometryQueued = true;
  requestAnimationFrame(() => {
    targetGeometryQueued = false;
    if (!pending && !retarget) return;
    const actionTarget = retarget || pending;
    const actionRects = targetRects(actionTarget);
    positionCommentAction(actionRects, actionTarget);
    renderSelectionCues(targetRects(pending));
    if (composeOpen) postTarget("eh:targetGeometry", pending);
    else postTarget("eh:target", pending);
  });
}

// ------------------------------------------------------------ text plumbing

const isOurs = (node) => {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  return !!(el && el.closest && el.closest(`[${UI_ATTR}]`));
};

/** Flatten the body's text nodes into one string plus an offset map. */
function flatten() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (isOurs(parent)) return NodeFilter.FILTER_REJECT;
      if (/^(script|style|noscript|template)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const map = [];
  let node = walker.nextNode();
  while (node) {
    const start = text.length;
    text += node.nodeValue;
    map.push({ node, start, end: text.length });
    node = walker.nextNode();
  }
  return { text, map };
}

/** Wrap a global offset span in <mark> elements, one per text node touched. */
function wrapOffsets(map, start, end, id) {
  const marks = [];
  for (const entry of map) {
    if (entry.end <= start || entry.start >= end) continue;
    const from = Math.max(0, start - entry.start);
    const to = Math.min(entry.node.nodeValue.length, end - entry.start);
    if (to <= from) continue;
    const range = document.createRange();
    try {
      range.setStart(entry.node, from);
      range.setEnd(entry.node, to);
      const mark = document.createElement("mark");
      mark.setAttribute(MARK_ATTR, id);
      range.surroundContents(mark);
      marks.push(mark);
    } catch {
      // A node that shifted under us is skipped rather than corrupting the DOM.
    }
  }
  return marks;
}

function marksFor(id) {
  return [...document.querySelectorAll(`mark[${MARK_ATTR}="${CSS.escape(id)}"]`)];
}

function unwrap(id) {
  for (const mark of marksFor(id)) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

// ------------------------------------------------------- target resolution

function isBlock(el) {
  if (!el || el.nodeType !== 1) return false;
  const display = getComputedStyle(el).display;
  return /^(block|flex|grid|list-item|table|flow-root)$/.test(display);
}

function hasOwnText(el) {
  return [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
}

/** A body-anchored, fully indexed path, so it resolves to one element only. */
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && parts.length < 8) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    const tag = node.tagName.toLowerCase();
    const twins = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : [];
    parts.unshift(twins.length > 1 ? `${tag}:nth-of-type(${twins.indexOf(node) + 1})` : tag);
    node = node.parentElement;
  }
  return ["body", ...parts].join(" > ");
}

/** The heading a block sits under, used to name edits in arbitrary HTML. */
function precedingHeading(el) {
  if (/^h[1-6]$/i.test(el.tagName) && el.textContent.trim()) return el.textContent.trim();
  let node = el;
  while (node && node !== document.body) {
    let sib = node.previousElementSibling;
    while (sib) {
      if (/^h[1-6]$/i.test(sib.tagName) && sib.textContent.trim()) return sib.textContent.trim();
      const nested = sib.querySelectorAll ? sib.querySelectorAll("h1,h2,h3,h4,h5,h6") : [];
      for (let i = nested.length - 1; i >= 0; i -= 1) {
        if (nested[i].textContent.trim()) return nested[i].textContent.trim();
      }
      sib = sib.previousElementSibling;
    }
    node = node.parentElement;
  }
  return "";
}

const clip = (text, limit = 40) => {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};

/**
 * A block's label is pinned the first time it is computed. Labels derived
 * from the block's own text or position would drift as the user types or
 * deletes siblings, splitting one block's edit into several contradictory
 * rows keyed on each intermediate wording.
 */
const pinnedLabels = new WeakMap();

/** The block a hover/edit belongs to, plus a human label for the edit list. */
function targetFor(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el || isOurs(el)) return null;

  const authored = el.closest("[data-container],[data-block]");
  if (authored) {
    const label = authored.getAttribute("data-container") || authored.getAttribute("data-block");
    return { el: authored, label: clip(label), authored: true };
  }

  let block = el;
  while (block && block !== document.body && !isBlock(block)) block = block.parentElement;
  if (!block || block === document.body || !block.textContent.trim()) {
    if (el !== document.body && MEDIA.test(el.tagName)) block = el;
    else return null;
  }

  if (!pinnedLabels.has(block)) {
    const heading = precedingHeading(block);
    const tag = block.tagName.toLowerCase();
    // Siblings of the same tag would otherwise share a label and collapse into
    // one edit row, so number them.
    const twins = block.parentElement ? [...block.parentElement.children].filter((c) => c.tagName === block.tagName) : [];
    const ordinal = twins.length > 1 ? ` ${twins.indexOf(block) + 1}` : "";
    pinnedLabels.set(block, heading ? `${clip(heading, 26)} · ${tag}${ordinal}` : clip(block.textContent, 40) || tag);
  }
  return { el: block, label: pinnedLabels.get(block), authored: false };
}

function commentTargetFor(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  const control = el?.closest?.("a[href], button, summary, input, select, textarea, [role='button'], [role='tab']");
  if (control && !isOurs(control)) {
    const label =
      control.getAttribute("aria-label") ||
      control.getAttribute("title") ||
      clip(control.textContent, 80) ||
      control.tagName.toLowerCase();
    return { el: control, label, authored: false };
  }
  return targetFor(node);
}

/**
 * The nearest rendered block around a node, ignoring authored data-block
 * containers. List conversion and drop targeting need the line the caret is
 * actually on, not the labeled region it reports edits under.
 */
function innermostBlock(node) {
  let el = node && node.nodeType === 1 ? node : node && node.parentElement;
  while (el && el !== document.body && !isBlock(el)) el = el.parentElement;
  return el && el !== document.body ? el : null;
}

/**
 * After a list command: hoist the fresh list out of the paragraph Chrome
 * sometimes nests it in (invalid HTML that a reparse would restructure), and
 * make sure the page's CSS reset can't hide it.
 */
function polishNewList(sel) {
  const node = sel && sel.anchorNode;
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const item = el && el.closest ? el.closest("li") : null;
  const list = item ? item.closest("ul, ol") : null;
  if (!list) return;
  const wrap = list.parentElement;
  if (wrap && /^(p|h[1-6])$/i.test(wrap.tagName) && wrap.childNodes.length === 1) {
    wrap.replaceWith(list);
  }
  const patch = listStyleFixup(list.tagName, getComputedStyle(list));
  if (patch.listStyleType) list.style.listStyleType = patch.listStyleType;
  if (patch.paddingLeft) list.style.paddingLeft = patch.paddingLeft;
}

/** The caret position a drag at (x, y) would drop into. */
function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    return range;
  }
  return null;
}

// ------------------------------------------------------------ serialization

const serialize = () => serializeDocument(document);

/**
 * A single block's HTML with every review artifact removed. outerHTML, not
 * innerHTML: changes to the block's own attributes (an image's new width, for
 * one) live on the element itself, and a void element has no inner markup.
 */
function blockHtml(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll(`[${UI_ATTR}]`).forEach((n) => n.remove());
  clone.querySelectorAll(`mark[${MARK_ATTR}]`).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  });
  clone.querySelectorAll("[data-eh-el]").forEach((n) => n.removeAttribute("data-eh-el"));
  clone.removeAttribute("data-eh-el");
  clone.normalize();
  return clone.outerHTML;
}

/**
 * Serialization is lossy about formatting, so a save that would not change the
 * document is skipped outright. Opening a file must never rewrite it.
 */
let baseline = null;
/** What the document looked like at boot, before any user edit. */
let bootSnapshot = null;

/**
 * Compare the live document against the file on disk (parsed the same way,
 * without running its scripts). A mismatch means the page renders itself —
 * writing the live DOM back would bake that output into the file, so saves
 * are disabled and edits travel to the agent as feedback only.
 */
function checkDynamic(diskHtml) {
  try {
    const parsed = new DOMParser().parseFromString(diskHtml, "text/html");
    if (serializeDocument(parsed) !== bootSnapshot) markDynamic();
  } catch {
    // If the comparison itself fails, keep saving as normal.
  }
}

function markDynamic() {
  if (dynamic) return;
  dynamic = true;
  clearTimeout(saveTimer);
  post("eh:dynamic", {});
}

/** True once the user has actually edited, as opposed to the page's own scripts. */
let userEdited = false;

/**
 * The boot comparison only catches scripts that rewrote the DOM before this
 * module ran. Pages that render on load or after a fetch (charts, mermaid,
 * client-rendered apps) mutate later — watch for any serialization drift that
 * happens before the first real user edit and treat it the same way.
 */
function watchSelfRendering() {
  const observer = new MutationObserver(() => {
    if (dynamic || userEdited) {
      observer.disconnect();
      return;
    }
    if (serialize() !== bootSnapshot) {
      observer.disconnect();
      markDynamic();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
}

function emitSave() {
  if (reviewMode !== "edit") return;
  if (savePolicy === "feedback-only" || dynamic) {
    post("eh:dynamic", {});
    return;
  }
  const html = serialize();
  if (html === baseline) {
    post("eh:clean", {});
    return;
  }
  baseline = html;
  post("eh:html", { html });
}

function scheduleSave() {
  if (reviewMode !== "edit") return;
  clearTimeout(saveTimer);
  if (savePolicy === "writable" && !dynamic) post("eh:saving", {});
  saveTimer = setTimeout(emitSave, SAVE_DEBOUNCE_MS);
}

function flushSave() {
  clearTimeout(saveTimer);
  flushEdits();
  emitSave();
}

let activeCaptureRequest = null;

function watchObservedView() {
  if (!lastObservedView) lastObservedView = observeView(document);
  const scheduleViewCheck = () => {
    clearTimeout(viewChangeTimer);
    viewChangeTimer = setTimeout(() => {
      viewChangeTimer = null;
      if (disposed) return;
      const view = observeView(document);
      if (sameObservedView(lastObservedView, view)) return;
      lastObservedView = view;
      hoverIntent?.reset();
      post("eh:viewChanged", { view });
    }, 200);
  };
  viewObserver?.disconnect();
  viewObserver = new MutationObserver(scheduleViewCheck);
  viewObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-selected", "hidden", "id", "aria-controls", "role", "aria-hidden"],
  });
  scheduleViewCheck();
}

async function captureSnapshot(msg) {
  const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 128 ? msg.requestId : null;
  const fail = (code, message) => post("eh:snapshot", { requestId, error: { code, message } });
  if (!requestId?.trim() || (msg.requireStable !== undefined && typeof msg.requireStable !== "boolean")) {
    fail("CAPTURE_INVALID_REQUEST", "A valid capture request ID and stability option are required.");
    return;
  }
  if (activeCaptureRequest) {
    if (activeCaptureRequest !== requestId) fail("CAPTURE_BUSY", "Another capture is in progress. Retry when it finishes.");
    return;
  }
  activeCaptureRequest = requestId;
  const started = Date.now();
  const href = location.href;
  let signature = null;
  let unchangedSince = started;
  let documentReady = false;
  try {
    flushSave();
    for (;;) {
      if (disposed || location.href !== href) {
        fail("CAPTURE_NAVIGATED", "The page navigated during capture. Recapture the current page.");
        return;
      }
      documentReady = document.readyState !== "loading" && !!document.body;
      if (documentReady) {
        const beforeView = observeView(document);
        const snapshot = captureSemanticSnapshot(document);
        const view = observeView(document);
        if (!sameObservedView(beforeView, view)) {
          fail("VIEW_CHANGED", "The visible tab changed during capture. Retry after the view settles.");
          return;
        }
        const capturedAt = Date.now();
        const next = JSON.stringify({ snapshot, view });
        const now = Date.now();
        if (next !== signature) {
          signature = next;
          unchangedSince = now;
        }
        if (msg.requireStable === false || now - unchangedSince >= CAPTURE_STABLE_MS) {
          // This orders queued edit messages before the snapshot; chrome still
          // owns the durable edit/autosave acknowledgement.
          flushSave();
          post("eh:snapshot", { requestId, snapshot, capturedAt, view });
          return;
        }
      }
      if (Date.now() - started >= CAPTURE_READY_TIMEOUT_MS) {
        fail(
          documentReady ? "CAPTURE_UNSTABLE" : "CAPTURE_NOT_READY",
          documentReady
            ? "The page is still changing. Retry, or explicitly capture its current state."
            : "The document is not ready. Retry after it has loaded."
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    const semanticError = typeof error?.code === "string" && error.code.startsWith("SEMANTIC_CAPTURE_");
    fail(
      semanticError ? error.code : "CAPTURE_FAILED",
      semanticError ? String(error.message).slice(0, 500) : "The page could not be captured. Retry from the current page."
    );
  } finally {
    activeCaptureRequest = null;
  }
}

function jumpToHistoryTarget(msg) {
  let success = false;
  try {
    if (typeof msg.selector === "string" && msg.selector.length > 0 && msg.selector.length <= 4096 &&
        typeof msg.text === "string" && msg.text.trim() && msg.text.length <= 200000) {
      const matches = document.querySelectorAll(msg.selector);
      if (matches.length === 1 && document.body.contains(matches[0]) && !isOurs(matches[0])) {
        const snapshot = captureSemanticSnapshot(document);
        const exact = snapshot.blocks.some((block) => {
          if (block.text !== msg.text) return false;
          if (typeof block.selector !== "string") return false;
          const current = document.querySelectorAll(block.selector);
          return current.length === 1 && current[0] === matches[0];
        });
        if (exact) {
          matches[0].scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          success = true;
        }
      }
    }
  } catch {
    // Stale, ambiguous, hidden, and invalid selectors remain unresolved.
  }
  post("eh:historyJumpResult", { success, ...(!success ? { reason: "unresolved" } : {}) });
}

// ------------------------------------------------------------- edit tracking

/**
 * One POST per keystroke would hammer the server (each save rewrites the whole
 * state file), so edits queue up and flush together. The store dedupes on
 * label+kind and only the latest `after` matters, so coalescing loses nothing.
 */
const editQueue = new Map();
let editTimer = null;

function flushEdits() {
  clearTimeout(editTimer);
  editTimer = null;
  for (const payload of editQueue.values()) post("eh:edit", payload);
  editQueue.clear();
}

function queueEdit(payload) {
  if (reviewMode !== "edit") return;
  const key = `${payload.label}\u0000${payload.kind}`;
  const queued = editQueue.get(key);
  if (queued && (queued.staged_assets || payload.staged_assets)) {
    const assets = [...(queued.staged_assets || []), ...(payload.staged_assets || [])];
    payload.staged_assets = [...new Map(assets.map((asset) => [asset.path || asset.id, asset])).values()];
  }
  editQueue.set(key, payload);
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdits, EDIT_FLUSH_MS);
}

// ------------------------------------------------------------- interactions

function clearPending({ keepRetarget = false } = {}) {
  hoverIntent?.reset();
  commentOpenRequestGeneration = null;
  pending = null;
  if (!keepRetarget) retarget = null;
  lastTargetGeometrySignature = "";
  lastTargetRelation = null;
  disconnectTargetObservers();
  place(els.activeBox, null);
  els.commentAction.style.display = "none";
  els.selectionCues.textContent = "";
  refreshGeometryWatch();
}

function restoreTargetFocus(target) {
  if (!target) return;
  if (target.kind === "element" && target.element?.isConnected) {
    const element = target.element;
    const focused = document.activeElement;
    if (document.hasFocus() && focused !== document.body && focused !== element && !isOurs(focused)) return;
    element.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (element.isConnected && document.activeElement === document.body) {
        element.focus({ preventScroll: true });
      }
    });
    return;
  }
  const range = target.range;
  if (!range || !document.body.contains(range.commonAncestorContainer)) return;
  const focusTarget = targetElement(target);
  if (focusTarget?.matches?.("a[href], button, input, select, textarea, summary, [tabindex]")) {
    focusTarget.focus({ preventScroll: true });
  } else if (reviewMode === "edit") {
    document.body.focus({ preventScroll: true });
  } else {
    window.focus();
  }
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Remember a settled selection without opening composition. The explicit
 * contextual action or keyboard shortcut owns that transition.
 */
function settleSelection() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer)) return false;
  if (isOurs(range.commonAncestorContainer)) return false;
  const quote = sel.toString();
  if (!quote.trim()) return false;

  const { text, map } = flatten();
  const offsets = normalizeSelectionRange(map, range);
  if (!offsets) return false;

  const context = buildContext(text, offsets.start, offsets.end);
  if (!context.quote.trim()) return false;
  const existing = [retarget, pending].find((target) =>
    target?.kind === "selection" && sameRange(target.range, offsets.range) &&
    target.context.quote === context.quote &&
    target.context.prefix === context.prefix &&
    target.context.suffix === context.suffix
  );
  if (existing) {
    if (existing === pending && retarget) {
      retarget = null;
      observePendingTarget(pending);
    }
    scheduleTargetGeometry();
    return true;
  }
  targetGeneration += 1;
  const target = {
    kind: "selection",
    quote,
    anchor: { ...context, selector: cssPath(range.commonAncestorContainer.parentElement || document.body) },
    context,
    range: offsets.range,
    generation: targetGeneration,
  };
  if (composeOpen && pending) retarget = target;
  else {
    pending = target;
    retarget = null;
  }
  observePendingTarget(target);
  scheduleTargetGeometry();
  return true;
}

function setElementTarget(container) {
  if (
    !container?.el ||
    (pending && pending.kind === "element" && pending.element === container.el) ||
    (retarget && retarget.kind === "element" && retarget.element === container.el)
  ) {
    if (pending || retarget) scheduleTargetGeometry();
    return;
  }
  targetGeneration += 1;
  const next = {
    kind: "element",
    element: container.el,
    quote: container.label,
    anchor: { selector: cssPath(container.el), label: container.label },
    generation: targetGeneration,
  };
  if (composeOpen && pending) retarget = next;
  else {
    pending = next;
    retarget = null;
  }
  observePendingTarget(next);
  scheduleTargetGeometry();
}

function openPendingCompose() {
  hoverIntent?.cancel();
  if (composing || disposed || !themeRevision) return false;
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount) {
    if (!settleSelection()) return false;
  } else if (!pending && !retarget) return false;
  const target = retarget || pending;
  clearTimeout(selectionTimer);
  commentOpenRequestGeneration = target.generation;
  postTarget("eh:openComment", target);
  return true;
}

function acceptCommentOpen(msg) {
  hoverIntent?.cancel();
  const requested = Number(msg.requestedGeneration);
  if (requested <= retiredComposeGeneration) return;
  if (commentOpenRequestGeneration === requested) commentOpenRequestGeneration = null;
  if (!msg.accepted) {
    const authoritative = Number(msg.targetGeneration);
    if (pending?.generation === authoritative) {
      composeOpen = true;
    } else if (retarget?.generation === authoritative) {
      pending = retarget;
      retarget = null;
      composeOpen = true;
      observePendingTarget(pending);
      scheduleTargetGeometry();
    } else {
      composeOpen = false;
    }
    diagnostic("composer-open-rejected", { targetGeneration: requested });
    return;
  }
  if (Number(msg.targetGeneration) !== requested) {
    diagnostic("geometry-rejected", { reason: "stale", targetGeneration: requested });
    return;
  }
  const acceptedGeneration = acceptedOpenGeneration(
    {
      pendingGeneration: pending?.generation || null,
      retargetGeneration: retarget?.generation || null,
    },
    { accepted: true, requestedGeneration: requested }
  );
  const candidate = retarget?.generation === acceptedGeneration
    ? retarget
    : pending?.generation === acceptedGeneration
      ? pending
      : null;
  if (!candidate) {
    diagnostic("geometry-rejected", { reason: "stale", targetGeneration: requested });
    return;
  }
  pending = candidate;
  retarget = null;
  composeOpen = true;
  lastTargetGeometrySignature = "";
  observePendingTarget(pending);
  positionCommentAction([]);
  renderSelectionCues(targetRects(pending));
  scheduleTargetGeometry();
}

function deactivateComment() {
  activeCommentId = null;
  for (const mark of document.querySelectorAll(`mark[${MARK_ATTR}]`)) mark.classList.remove("eh-active");
  place(els.activeBox, null);
  renderBlockAnnotations();
  refreshGeometryWatch();
}

function revealTarget(generation) {
  diagnostic("reveal-target-requested", { targetGeneration: generation });
  if (!composeOpen || !pending || pending.generation !== generation || !targetConnected(pending)) {
    diagnostic("reveal-target-failed", { targetGeneration: generation });
    post("eh:revealTargetResult", { targetGeneration: generation, success: false });
    return;
  }
  const target = pending.kind === "element"
    ? pending.element
    : pending.range.startContainer.nodeType === Node.ELEMENT_NODE
      ? pending.range.startContainer
      : pending.range.startContainer.parentElement;
  if (!target?.isConnected) {
    diagnostic("reveal-target-failed", { targetGeneration: generation });
    post("eh:revealTargetResult", { targetGeneration: generation, success: false });
    return;
  }
  target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const authoritative = composeOpen && pending && pending.generation === generation;
      const revealed = authoritative && targetGeometry(pending).relation === "visible";
      scheduleTargetGeometry();
      diagnostic(revealed ? "reveal-target-succeeded" : "reveal-target-failed", {
        targetGeneration: generation,
      });
      post("eh:revealTargetResult", { targetGeneration: generation, success: revealed });
    });
  });
}

/** Commit turns the remembered range into real <mark> wrappers. */
function commitPending(id, generation, { restoreFocus = false } = {}) {
  if (!pending || (generation && generation !== pending.generation)) return;
  if (pending.kind === "element") {
    if (pending.element?.isConnected) blockTargets.set(id, pending.element);
  } else {
    const { text, map } = flatten();
    const hit = findQuote(text, pending.context);
    if (hit) wrapOffsets(map, hit.start, hit.end, id);
  }
  if (restoreFocus) restoreTargetFocus(pending);
  else {
    const sel = document.getSelection();
    if (sel) sel.removeAllRanges();
  }
  clearPending({ keepRetarget: true });
  renderBlockAnnotations();
}

function reanchor(comments) {
  const authoritative = new Set((comments || []).map((comment) => String(comment.id)));
  const staleMarks = new Set();
  for (const mark of document.querySelectorAll(`mark[${MARK_ATTR}]`)) {
    const id = mark.getAttribute(MARK_ATTR);
    if (id && !authoritative.has(id)) staleMarks.add(id);
  }
  for (const id of staleMarks) unwrap(id);
  for (const element of document.querySelectorAll("[data-eh-el]")) {
    const id = element.getAttribute("data-eh-el");
    if (authoritative.has(id) && !blockTargets.has(id)) blockTargets.set(id, element);
    element.removeAttribute("data-eh-el");
  }
  for (const id of blockTargets.keys()) if (!authoritative.has(id)) blockTargets.delete(id);
  if (activeCommentId && !authoritative.has(activeCommentId)) {
    const staleId = activeCommentId;
    activeCommentId = null;
    place(els.activeBox, null);
    post("eh:commentGeometry", { id: staleId, rects: [], visible: false, viewport: viewportData() });
  }

  const resolved = [];
  const orphaned = [];
  for (const comment of comments) {
    if (marksFor(comment.id).length) {
      resolved.push(comment.id);
      continue;
    }
    if (comment.kind === "element") {
      let el = blockTargets.get(comment.id);
      if (!el?.isConnected) {
        try {
          const matches = comment.anchor?.selector ? [...document.querySelectorAll(comment.anchor.selector)].filter((element) => !isOurs(element)) : [];
          el = matches.length === 1 ? matches[0] : null;
        }
        catch { el = null; }
      }
      if (el && !isOurs(el)) blockTargets.set(comment.id, el);
      else { el = null; blockTargets.delete(comment.id); }
      (el ? resolved : orphaned).push(comment.id);
      continue;
    }
    const { text, map } = flatten();
    const hit = comment.anchor ? findQuote(text, comment.anchor) : null;
    if (!hit) {
      orphaned.push(comment.id);
      continue;
    }
    const marks = wrapOffsets(map, hit.start, hit.end, comment.id);
    (marks.length ? resolved : orphaned).push(comment.id);
  }
  if (!threadAnchors?.projection) post("eh:anchorStatus", { resolved, orphaned });
  renderBlockAnnotations();
}

function hiddenThreadTarget(element) {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" || style.display === "none" ||
        style.visibility === "hidden" || style.visibility === "collapse" ||
        style.contentVisibility === "hidden" || Number(style.opacity) === 0) return true;
  }
  return false;
}

const threadElements = new Map();
function resolveThreadAnchor({ threadId, target }) {
  threadTargets.delete(threadId);
  const unavailable = (reason) => ({ threadId, state: "unavailable", reason });
  if (!document.body || document.readyState === "loading") return unavailable("render-loading");
  let resolved;
  if (target.kind === "element") {
    let candidates;
    try {
      candidates = [...document.querySelectorAll(target.anchor.selector)]
        .filter((element) => document.body.contains(element) && !isOurs(element));
    } catch (error) {
      if (error.name !== "SyntaxError") throw error;
      return unavailable("invalid-selector");
    }
    if (!candidates.length) return { threadId, state: "missing" };
    if (candidates.length > 1) return { threadId, state: "ambiguous", candidateCount: candidates.length };
    const previous = threadElements.get(threadId);
    if (previous && previous !== candidates[0]) return unavailable("render-changed");
    threadElements.set(threadId, candidates[0]);
    if (hiddenThreadTarget(candidates[0])) return unavailable("hidden");
    resolved = { kind: "element", element: candidates[0] };
  } else {
    const { text, map } = flatten();
    const hit = resolveQuote(text, target.anchor);
    if (hit.state !== "found") return { threadId, ...hit };
    const entries = map.filter((entry) => entry.end > hit.start && entry.start < hit.end);
    if (!entries.length) return unavailable("not-measurable");
    if (entries.some((entry) => hiddenThreadTarget(entry.node.parentElement))) return unavailable("hidden");
    const range = document.createRange();
    range.setStart(entries[0].node, hit.start - entries[0].start);
    range.setEnd(entries.at(-1).node, hit.end - entries.at(-1).start);
    resolved = { kind: "selection", range };
  }
  const raw = targetRects(resolved).filter((rect) => rect.width > 0 && rect.height > 0);
  if (!raw.length) return unavailable("not-measurable");
  const viewport = viewportData();
  const relationTo = (clip) => raw.every((rect) => rect.bottom <= clip.top) ? "above"
    : raw.every((rect) => rect.top >= clip.bottom) ? "below"
      : raw.every((rect) => rect.right <= clip.left) ? "left"
        : raw.every((rect) => rect.left >= clip.right) ? "right" : "visible";
  const viewportRelation = relationTo({ left: 0, top: 0, right: viewport.width, bottom: viewport.height });
  const clip = effectiveClipRect(resolved);
  const relation = viewportRelation !== "visible" ? viewportRelation : clip ? relationTo(clip) : null;
  if (!relation) return unavailable("not-measurable");
  const rects = relation === "visible" ? raw.map((rect) => intersectRects(rect, clip)).filter(Boolean) : raw;
  if (!rects.length) return unavailable("not-measurable");
  threadTargets.set(threadId, resolved);
  return { threadId, state: "found", rects, viewport, relation };
}

threadAnchors = createThreadAnchorController({
  channel: frameMessage("scope"),
  resolve: resolveThreadAnchor,
  reconcile(projection, states) {
    const found = new Set(states.anchors.filter((anchor) => anchor.state === "found").map((anchor) => anchor.threadId));
    for (const threadId of found) {
      const target = threadTargets.get(threadId);
      if (target.kind === "element") blockTargets.set(threadId, target.element);
      else {
        const marks = marksFor(threadId);
        if (marks.length && (!marks.some((mark) => mark.contains(target.range.startContainer)) ||
            !marks.some((mark) => mark.contains(target.range.endContainer)) ||
            marks.map((mark) => mark.textContent).join("") !== target.range.toString())) unwrap(threadId);
      }
    }
    reanchor(projection.anchors.filter((anchor) => found.has(anchor.threadId)).map(({ threadId, target }) => ({
      id: threadId, kind: target.kind, anchor: target.anchor,
    })));
    for (const threadId of found) {
      const state = states.anchors.find((item) => item.threadId === threadId);
      const peers = states.anchors.filter((item) => sameThreadTarget(item, state)).map((item) => item.threadId);
      const marks = marksFor(threadId);
      for (const [index, mark] of marks.entries()) {
        const nestedPeer = [...mark.querySelectorAll(`mark[${MARK_ATTR}]`)].some((nested) => peers.includes(nested.getAttribute(MARK_ATTR)));
        const interactive = index === 0 && !nestedPeer;
        if (mark.tabIndex !== (interactive ? 0 : -1)) mark.tabIndex = interactive ? 0 : -1;
        const role = interactive ? "button" : "presentation";
        if (mark.getAttribute("role") !== role) mark.setAttribute("role", role);
        const label = peers.length > 1 ? `Open ${peers.length} conversations` : "Open conversation";
        if (interactive && mark.getAttribute("aria-label") !== label) mark.setAttribute("aria-label", label);
        if (!interactive && mark.hasAttribute("aria-label")) mark.removeAttribute("aria-label");
      }
    }
  },
  changed(_projection, states) {
    post("eh:threadAnchorStates", states);
  },
});

function threadAction(action, threadId) {
  const { anchors: _anchors, type: _type, ...scope } = threadAnchors.projection;
  return threadAnchors.action({ type: "eh:threadAction", ...scope, action, threadId });
}
function requestThreadActivation(id) {
  if (!threadAnchors.projection) { post("eh:activate", { id }); return; }
  try { post("eh:threadAction", threadAction("activate", id)); }
  catch (error) { diagnostic("thread-boundary-rejected", { message: error.message }); }
}

function activate(id, scroll) {
  activeCommentId = id || null;
  const marks = marksFor(id);
  let target = marks[0] || null;
  if (!target) {
    const el = blockTargets.get(id);
    if (el) target = el;
  }
  for (const mark of document.querySelectorAll(`mark[${MARK_ATTR}]`)) mark.classList.remove("eh-active");
  for (const mark of marks) mark.classList.add("eh-active");
  place(els.activeBox, target);
  renderBlockAnnotations();
  const rects = marks.length
    ? marks.map((mark) => rectData(mark.getBoundingClientRect()))
    : target
      ? [rectData(target.getBoundingClientRect())]
      : [];
  const visible = visibleRects(rects, { kind: "element", element: target });
  post("eh:commentGeometry", {
    id,
    rects: visible,
    visible: visible.length > 0,
    viewport: viewportData(),
  });
  refreshGeometryWatch();
  if (target && scroll) {
    // Reveal a target hidden inside a collapsed tab or accordion.
    let hidden = target.closest("[hidden]") || null;
    if (!hidden) {
      let probe = target.parentElement;
      while (probe && probe !== document.body) {
        if (getComputedStyle(probe).display === "none") {
          hidden = probe;
          break;
        }
        probe = probe.parentElement;
      }
    }
    if (hidden) {
      const control = hidden.id ? document.querySelector(`[aria-controls="${CSS.escape(hidden.id)}"]`) : null;
      if (control) control.click();
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      post("eh:notInView", { id });
      return;
    }
    // scrollIntoView walks every scrollable ancestor, so targets inside an
    // app's inner scroll container are reached too, not just window-scrolled ones.
    target.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => { if (!disposed && activeCommentId === id) activate(id, false); }, 180);
  }
}

// -------------------------------------------------------------------- boot

/* REVIEW_THEME_DOCUMENT_START */
const REVIEW_DOCUMENT_COLORS = {
  light: `
    mark[${MARK_ATTR}] { background: #FFF1D9; color: #75470E; text-decoration: underline #915B13; }
    mark[${MARK_ATTR}]:hover, mark[${MARK_ATTR}].eh-active { background: #F5D6A3; }
    mark[${MARK_ATTR}].eh-active { outline: 2px solid #915B13; outline-offset: 1px; }
    ::selection { background: #F5D6A3; color: #75470E; }
  `,
  dark: `
    mark[${MARK_ATTR}] { background: #3D3020; color: #F1CC8E; text-decoration: underline #E7BB72; }
    mark[${MARK_ATTR}]:hover, mark[${MARK_ATTR}].eh-active { background: #594325; }
    mark[${MARK_ATTR}].eh-active { outline: 2px solid #E7BB72; outline-offset: 1px; }
    ::selection { background: #594325; color: #F1CC8E; }
  `,
};
/* REVIEW_THEME_DOCUMENT_END */

function boot() {
  document.addEventListener("keydown", (event) => {
    if (!threadAnchors.projection || event.isComposing || event.keyCode === 229) return;
    const mark = event.target.closest?.(`mark[${MARK_ATTR}]`);
    if (mark && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); event.stopPropagation();
      requestThreadActivation(mark.getAttribute(MARK_ATTR));
    } else if (event.key === "Escape" && activeCommentId &&
        (isOurs(event.target) || !event.target.closest?.("input,textarea,select,[contenteditable='true']"))) {
      try {
        post("eh:threadAction", threadAction("dismiss", activeCommentId));
        deactivateComment(); event.preventDefault(); event.stopPropagation();
      } catch (error) { diagnostic("thread-boundary-rejected", { message: error.message }); }
    }
  });
  mountOverlay();

  const style = document.createElement("style");
  style.setAttribute("data-eh-sdk", "");
  const documentStyle = `
    mark[${MARK_ATTR}] { background: transparent; border-radius: 2px; color: inherit; cursor: pointer; }
    body[contenteditable]:focus { outline: none; }
  `;
  style.textContent = documentStyle;
  document.head.appendChild(style);

  const applyReviewTheme = (message) => {
    const allowedFields = ["type", "theme", "themeRevision", "capability", "generation", "pageKey"];
    const malformed = !["light", "dark"].includes(message.theme) ||
      !Number.isSafeInteger(message.themeRevision) || message.themeRevision <= 0 ||
      Object.keys(message).some((field) => !allowedFields.includes(field));
    const conflicting = message.themeRevision === themeRevision && message.theme !== reviewTheme;
    if (malformed || conflicting) {
      if (themeWarnings++ < 3) console.warn("[doc-review-frame] Rejected invalid theme command.");
      return;
    }
    if (message.themeRevision < themeRevision) return;
    if (message.themeRevision > themeRevision) {
      // Only review-owned nodes change: keep the document, controls, focus and mode intact.
      style.textContent = documentStyle + REVIEW_DOCUMENT_COLORS[message.theme];
      host.dataset.reviewTheme = message.theme;
      reviewTheme = message.theme;
      themeRevision = message.themeRevision;
    }
    post("eh:themeApplied", { theme: reviewTheme, themeRevision });
  };

  modeController = keepBodyInReviewMode(document.body, "view");
  baseline = serialize();
  bootSnapshot = baseline;
  watchSelfRendering();
  watchObservedView();

  const notifyChromeInteraction = (event) => {
    if (isOurs(event.target)) return;
    post("eh:interaction", { interaction: event.type });
  };
  document.addEventListener("pointerdown", notifyChromeInteraction, true);
  document.addEventListener("focusin", notifyChromeInteraction, true);
  window.addEventListener("focus", notifyChromeInteraction, true);

  document.addEventListener("mouseup", (event) => {
    if (isOurs(event.target) || resizing || Date.now() < suppressUntil) return;
    setTimeout(() => {
      if (settleSelection()) return;
      if (!composeOpen && !commentOpenRequestGeneration) {
        if (pending?.kind === "selection") clearPending();
        if (!selectionIsActive()) {
          const target = event.target?.isConnected && commentTargetFor(event.target);
          if (target) setElementTarget(target);
          else restoreElementCommentTarget();
        }
      }
    }, 0);
  });

  document.addEventListener(
    "click",
    (event) => {
      if (isOurs(event.target)) return;
      const modified = event.metaKey || event.ctrlKey;
      const href = navigationHref(event.target);
      const mark = event.target.closest && event.target.closest(`mark[${MARK_ATTR}]`);
      if (mark && themeRevision) {
        event.preventDefault();
        requestThreadActivation(mark.getAttribute(MARK_ATTR));
        return;
      }

      if (reviewMode === "view") {
        if (href) {
          event.preventDefault();
          event.stopPropagation();
          const classification = classifyHref(href);
          if (classification === "external") {
            const external = externalHref(href, document.baseURI);
            if (external) post("eh:external", { href: external });
          }
          else if (classification === "hash") {
            const action = hashClickAction(href, location.hash);
            if (action.kind === "scroll") {
              const el = document.getElementById(action.id) || document.getElementsByName(action.id)[0] || document.body;
              el.scrollIntoView({ behavior: "smooth" });
            } else {
              location.hash = action.hash;
            }
          }
          else if (classification === "navigate") {
            post("eh:navigate", { href });
          }
        }
        return;
      }

      if (modified) {
        if (href) {
          event.preventDefault();
          event.stopPropagation();
          const classification = classifyHref(href);
          if (classification === "external") {
            const external = externalHref(href, document.baseURI);
            if (external) post("eh:external", { href: external });
          } else if (classification === "hash") {
            const action = hashClickAction(href, location.hash);
            if (action.kind === "scroll") {
              const el = document.getElementById(action.id) || document.getElementsByName(action.id)[0] || document.body;
              el.scrollIntoView({ behavior: "smooth" });
            } else {
              location.hash = action.hash;
            }
          } else if (classification === "navigate") {
            flushSave();
            post("eh:navigate", { href });
          }
        }
        return;
      }

      // Edit keeps activation suppression so direct manipulation cannot navigate.
      if (href || (event.target.closest && event.target.closest("button, [role='button'], summary"))) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );

  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    if (reviewMode === "edit") {
      if (!event.metaKey && !event.ctrlKey) event.preventDefault();
      return;
    }
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const method = String(submitter?.formMethod || form.method || "get").toLowerCase();
    if (method === "dialog") return;
    event.preventDefault();
    if (method !== "get") {
      post("eh:formBlocked", { reason: "Only GET form navigation is available in View mode." });
      return;
    }
    const action =
      submitter?.getAttribute("formaction") ??
      form.getAttribute("action") ??
      "";
    if (!action) {
      post("eh:formBlocked", { reason: "This form does not name a reviewable destination." });
      return;
    }
    const query = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === "string") query.append(name, value);
    }
    if (submitter?.name) query.append(submitter.name, submitter.value);
    const hashIndex = action.indexOf("#");
    const hash = hashIndex >= 0 ? action.slice(hashIndex) : "";
    const base = hashIndex >= 0 ? action.slice(0, hashIndex) : action;
    const separator = base.includes("?") ? "&" : "?";
    const href = query.size ? `${base}${separator}${query}${hash}` : action;
    post("eh:navigate", { href });
  });

  const inCommentApproach = (event) => pending?.kind === "element" &&
    pending.element.isConnected &&
    pointInCommentApproach(
      { x: event.clientX, y: event.clientY },
      pending.element.getBoundingClientRect(),
      els.commentAction.getBoundingClientRect()
    );
  const clearHover = () => {
    hoverTarget = hoverMove = hoverMedia = null;
    place(els.outline, null);
    showChip(null);
    showMover(null);
    showGrip(null);
    showHint("");
    if (!composeOpen && !commentOpenRequestGeneration && pending?.kind === "element" &&
      !pending.element?.contains(document.activeElement)) clearPending();
  };
  hoverIntent = createHoverIntent((event) => {
    if (disposed || !themeRevision || pointerSelecting || composing || composeOpen || selectionIsActive()) return;
    if (!event) { clearHover(); return; }
    if (!event.target?.isConnected) { hoverIntent.reset(); clearHover(); return; }
    const target = commentTargetFor(event.target);
    hoverTarget = target ? target.el : null;
    // The move handle works per element, not per labeled container, so each
    // paragraph inside a card can travel on its own.
    hoverMove = hoverTarget ? innermostBlock(event.target) || hoverTarget : null;
    hoverMedia = event.target.closest ? event.target.closest("img, video") : null;
    place(els.outline, hoverTarget);
    const selectionActive = selectionIsActive();
    if (!selectionActive && target && !composeOpen && !commentOpenRequestGeneration) setElementTarget(target);
    if (reviewMode !== "edit" || controlsAreSuppressed()) hideActionControls();
    else {
      showChip(hoverTarget);
      showMover(hoverMove);
    }
    showGrip(reviewMode === "edit" ? hoverMedia : null);
    const interactive = event.target.closest && event.target.closest("a[href], [data-href], button, [role='button']");
    const draggable = hoverMedia && hoverMedia.tagName === "IMG";
    showHint(reviewMode === "edit" && interactive ? "⌘-click to open" : reviewMode === "edit" && draggable ? "Drag to move" : "", event.clientX, event.clientY);
  });
  const updateHover = (event) => {
    if (disposed || !themeRevision || resizing || moving || pointerSelecting || composing || composeOpen ||
      commentOpenRequestGeneration || selectionIsActive()) { hoverIntent.cancel(); return; }
    if (isOurs(event.target)) { hoverIntent.cancel(); return; }
    // The committed paragraph owns the entire trip to its action, including
    // intervening whitespace/containers. Leaving the corridor starts new dwell.
    if (pending?.kind === "element" && !pending.element.contains(event.target) && inCommentApproach(event)) {
      hoverIntent.cancel();
      return;
    }
    const target = commentTargetFor(event.target);
    hoverIntent.request(target?.el || null, target ? {
      target: event.target, clientX: event.clientX, clientY: event.clientY,
    } : null);
  };
  document.addEventListener("mouseover", updateHover);
  document.addEventListener("mousemove", updateHover);

  document.addEventListener("pointerdown", (event) => {
    hoverIntent.cancel();
    if (!isOurs(event.target) && event.button === 0) pointerSelecting = true;
  }, true);
  document.addEventListener("pointerup", () => { pointerSelecting = false; }, true);
  document.addEventListener("pointercancel", () => { pointerSelecting = false; hoverIntent.reset(); }, true);
  document.addEventListener("compositionstart", () => {
    composing = true;
    hoverIntent.reset();
    place(els.outline, null);
  }, true);
  document.addEventListener("compositionend", () => { composing = false; }, true);

  document.addEventListener("focusin", (event) => {
    hoverIntent.reset();
    if (isOurs(event.target) || selectionIsActive() || composeOpen || composing) return;
    const target = commentTargetFor(event.target);
    if (target) setElementTarget(target);
  });

  document.addEventListener("mouseleave", () => {
    if (resizing || moving) return;
    hoverIntent.request(null, null);
  });
  const cancelHover = () => {
    hoverIntent.reset();
    pointerSelecting = false;
    clearHover();
  };
  window.addEventListener("blur", cancelHover);
  window.addEventListener("hashchange", cancelHover);
  window.addEventListener("popstate", cancelHover);
  window.addEventListener("pagehide", () => {
    disposed = true;
    cancelHover();
    clearTimeout(selectionTimer);
    clearTimeout(viewChangeTimer);
    viewObserver?.disconnect();
    clearTimeout(controlRestoreTimer);
    clearInterval(geometryWatchTimer);
    geometryWatchTimer = null;
    disconnectTargetObservers();
  });
  window.addEventListener("pageshow", () => {
    disposed = false;
    watchObservedView();
    renderBlockAnnotations();
  });

  els.commentAction.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  els.commentAction.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPendingCompose();
  });

  // ------------------------------------------------------------ image resize

  els.grip.addEventListener("pointerdown", (event) => {
    if (reviewMode !== "edit") return;
    if (!hoverMedia || !hoverMedia.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    // From here on, DOM changes are the human resizing, not the page rendering.
    userEdited = true;
    const target = targetFor(hoverMedia);
    const blockEl = target ? target.el : hoverMedia;
    resizing = {
      el: hoverMedia,
      startX: event.clientX,
      startWidth: hoverMedia.getBoundingClientRect().width,
      label: target ? target.label : "Image",
      blockEl,
      beforeText: blockEl.textContent,
      beforeHtml: blockHtml(blockEl),
    };
    if (els.grip.setPointerCapture) els.grip.setPointerCapture(event.pointerId);
  });

  window.addEventListener("pointermove", (event) => {
    if (!resizing) return;
    event.preventDefault();
    const width = Math.max(24, Math.round(resizing.startWidth + (event.clientX - resizing.startX)));
    resizing.el.style.width = `${width}px`;
    resizing.el.style.height = "auto";
    place(els.outline, hoverTarget);
    showGrip(resizing.el);
  });

  window.addEventListener("pointerup", () => {
    if (!resizing) return;
    const { blockEl, label, beforeText, beforeHtml } = resizing;
    resizing = null;
    suppressUntil = Date.now() + 250;
    queueEdit({
      label,
      kind: "edited",
      before: beforeText,
      after: blockEl.textContent,
      before_html: beforeHtml,
      after_html: blockHtml(blockEl),
    });
    scheduleSave();
  });

  els.chipDelete.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (reviewMode !== "edit" || !hoverTarget) return;
    userEdited = true;
    const target = targetFor(hoverTarget);
    const label = target ? target.label : "Element";
    const before = hoverTarget.textContent;
    const before_html = blockHtml(hoverTarget);
    hoverTarget.remove();
    hoverTarget = null;
    place(els.outline, null);
    showChip(null);
    queueEdit({ label, kind: "deleted", before, before_html, after: "" });
    flushSave();
  });

  // beforeinput still sees the untouched wording, so capture it once per block.
  const originalText = new WeakMap();
  const originalHtml = new WeakMap();
  const capturedBlocks = new Set();
  const captureOriginal = (el) => {
    if (!originalText.has(el)) {
      originalText.set(el, el.textContent);
      originalHtml.set(el, blockHtml(el));
      capturedBlocks.add(el);
    }
  };

  /** An edit row for a block changed outside the input-event flow (attribute
   * set, link removal, drag move) — the same shape the input listener emits. */
  const emitBlockEdit = (blockEl, fallbackLabel, extra = {}) => {
    const connected = blockEl.isConnected;
    const target = connected ? targetFor(blockEl) : null;
    queueEdit({
      label: (target && target.label) || fallbackLabel || "Document body",
      kind: "edited",
      before: originalText.get(blockEl),
      after: connected ? blockEl.textContent : "",
      before_html: originalHtml.get(blockEl),
      after_html: connected ? blockHtml(blockEl) : "",
      ...extra,
    });
  };

  let typingUntil = 0;
  let controlRestoreTimer = null;

  const selectionIsActive = () => {
    const sel = document.getSelection();
    return !!(sel && !sel.isCollapsed && sel.rangeCount && document.body.contains(sel.getRangeAt(0).commonAncestorContainer));
  };

  const restoreElementCommentTarget = () => {
    if (composeOpen || composing || pointerSelecting || commentOpenRequestGeneration || selectionIsActive()) return;
    const focused = document.activeElement;
    const target = focused && focused !== document.body && focused !== document.documentElement && !isOurs(focused)
      ? commentTargetFor(focused)
      : hoverTarget?.isConnected ? commentTargetFor(hoverTarget) : null;
    if (target) setElementTarget(target);
  };

  const controlsAreSuppressed = () => Date.now() < typingUntil || selectionIsActive();

  const hideActionControls = () => {
    showChip(null);
    showMover(null);
  };

  const restoreActionControls = () => {
    if (controlsAreSuppressed()) return;
    showChip(hoverTarget);
    showMover(hoverMove);
  };

  const suppressActionControlsWhileTyping = () => {
    typingUntil = Date.now() + 800;
    hideActionControls();
    clearTimeout(controlRestoreTimer);
    controlRestoreTimer = setTimeout(restoreActionControls, 810);
  };
  document.addEventListener(
    "beforeinput",
    (event) => {
      if (isOurs(event.target) || reviewMode !== "edit") return;
      suppressActionControlsWhileTyping();
      // From here on, DOM drift is the human typing, not the page rendering.
      userEdited = true;
      const sel = document.getSelection();
      const target = targetFor(sel && sel.anchorNode ? sel.anchorNode : event.target);
      if (target) captureOriginal(target.el);
    },
    true
  );

  document.addEventListener("selectionchange", () => {
    hoverIntent.cancel();
    if (selectionIsActive()) place(els.outline, null);
    clearTimeout(selectionTimer);
    if (!commentOpenRequestGeneration) els.commentAction.style.display = "none";
    selectionTimer = setTimeout(() => {
      if (selectionIsActive()) {
        hideActionControls();
        if (!settleSelection() && !composeOpen && !commentOpenRequestGeneration) clearPending();
      } else {
        restoreActionControls();
        if (!composeOpen && !commentOpenRequestGeneration) {
          if (pending?.kind === "selection") clearPending();
          restoreElementCommentTarget();
        }
      }
    }, 40);
  });

  // ------------------------------------------------------------------ links

  let linkState = null; // { range, anchor, blockEl, label } while the ⌘K popup is open

  function closeLinkbox(restoreSelection) {
    if (!linkState) return;
    const { range } = linkState;
    linkState = null;
    els.linkbox.style.display = "none";
    if (restoreSelection && range) {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.body.focus({ preventScroll: true });
    }
  }

  function positionLinkbox() {
    if (!linkState) return false;
    const { range, anchor, blockEl, startNode, endNode } = linkState;
    if (!startNode.isConnected || !endNode.isConnected || (anchor && !anchor.isConnected) ||
      (blockEl && !blockEl.isConnected) || !document.body.contains(range.commonAncestorContainer)) {
      closeLinkbox(false);
      return false;
    }
    const rects = visibleRects([...range.getClientRects()].map(rectData), {
      kind: "element", element: anchor || blockEl || startNode.parentElement,
    });
    if (!rects.length) {
      closeLinkbox(false);
      return false;
    }
    const r = rects[0];
    const width = els.linkbox.offsetWidth || 320;
    const height = els.linkbox.offsetHeight || 36;
    const below = r.bottom + height + 8 < window.innerHeight;
    els.linkbox.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    els.linkbox.style.top = `${Math.max(8, Math.min(below ? r.bottom + 8 : r.top - height - 8, window.innerHeight - height - 8))}px`;
    return true;
  }

  function openLinkbox() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return false;
    let range = sel.getRangeAt(0).cloneRange();
    const container = range.commonAncestorContainer;
    if (!document.body.contains(container) || isOurs(container)) return false;

    const caretEl = container.nodeType === 1 ? container : container.parentElement;
    const anchor = caretEl && caretEl.closest ? caretEl.closest("a") : null;
    if (sel.isCollapsed) {
      // A bare caret can only mean "edit the link I'm inside".
      if (!anchor) return false;
      range = document.createRange();
      range.selectNodeContents(anchor);
    }
    const target = targetFor(anchor || container);
    linkState = {
      range,
      anchor,
      blockEl: target ? target.el : null,
      label: target ? target.label : "Document body",
      startNode: range.startContainer,
      endNode: range.endContainer,
    };
    if (linkState.blockEl) captureOriginal(linkState.blockEl);

    // The compose card and the link popup fight over the same selection.
    clearPending();
    post("eh:dismiss", {});

    els.linkbox.style.display = "flex";
    els.linkRemove.style.display = anchor ? "" : "none";
    if (!positionLinkbox()) return false;
    els.linkInput.value = anchor ? anchor.getAttribute("href") || "" : "";
    els.linkInput.focus();
    els.linkInput.select();
    return true;
  }

  function applyLink() {
    if (!linkState) return;
    const href = normalizeHref(els.linkInput.value);
    const { range, anchor, blockEl, label } = linkState;
    if (!href) {
      // Nothing typed → dismiss. Something unusable typed → stay open so the
      // input isn't silently thrown away.
      if (!els.linkInput.value.trim()) closeLinkbox(true);
      else els.linkInput.select();
      return;
    }
    userEdited = true;
    linkState = null;
    els.linkbox.style.display = "none";
    if (anchor && anchor.isConnected) {
      // Editing an existing link never rewraps — just retarget it.
      anchor.setAttribute("href", href);
      if (blockEl) emitBlockEdit(blockEl, label);
    } else {
      const sel = document.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.body.focus({ preventScroll: true });
      document.execCommand("createLink", false, href);
      // On pages that reset anchor styling the new link looks like plain
      // prose — underline it so the user sees that it took.
      const node = sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const created = el && el.closest ? el.closest("a") : null;
      if (created) {
        const patch = linkStyleFixup(
          getComputedStyle(created),
          created.parentElement ? getComputedStyle(created.parentElement) : null
        );
        if (patch.textDecoration) created.style.textDecoration = patch.textDecoration;
      }
    }
    scheduleSave();
  }

  function removeLink() {
    if (!linkState) return;
    const { anchor, blockEl, label } = linkState;
    linkState = null;
    els.linkbox.style.display = "none";
    if (!anchor || !anchor.isConnected) return;
    userEdited = true;
    const parent = anchor.parentNode;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    parent.removeChild(anchor);
    parent.normalize();
    if (blockEl) emitBlockEdit(blockEl, label);
    scheduleSave();
  }

  els.linkInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeLinkbox(true);
    }
  });
  els.linkApply.addEventListener("click", applyLink);
  els.linkRemove.addEventListener("click", removeLink);

  // A click anywhere in the page means the popup lost the argument.
  document.addEventListener("pointerdown", (event) => {
    if (linkState && !isOurs(event.target)) closeLinkbox(false);
  });

  // ------------------------------------------------------------------ lists

  // execCommand mutations fire `input` (so edit rows and saves flow as usual)
  // but not `beforeinput`, so originals are captured here by hand.
  document.addEventListener(
    "keydown",
    (event) => {
      if (isOurs(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      const sel = document.getSelection();
      const anchor = sel ? sel.anchorNode : null;

      if (
        event.altKey &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "m"
      ) {
        if (selectionIsActive()) settleSelection();
        if (openPendingCompose()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (reviewMode !== "edit") return;

      // ⌘K links the selection, like Docs, Word, and Notion.
      if (meta && !event.shiftKey && !event.altKey && (event.key === "k" || event.key === "K")) {
        if (openLinkbox()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (event.key === "Escape" && linkState) {
        closeLinkbox(true);
        return;
      }

      // ⌘⇧8 bulleted, ⌘⇧7 numbered — the shortcuts people know from Docs.
      if (meta && event.shiftKey && (event.code === "Digit7" || event.code === "Digit8")) {
        const target = targetFor(anchor || event.target);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        captureOriginal(target.el);
        document.execCommand(event.code === "Digit7" ? "insertOrderedList" : "insertUnorderedList");
        polishNewList(document.getSelection());
        scheduleSave();
        return;
      }

      // Tab indents and Shift+Tab outdents inside a list, instead of leaving the page.
      if (event.key === "Tab" && anchor) {
        const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        const item = el && el.closest ? el.closest("li") : null;
        if (!item || isOurs(item)) return;
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        const target = targetFor(item);
        if (target) captureOriginal(target.el);
        document.execCommand(event.shiftKey ? "outdent" : "indent");
        polishNewList(document.getSelection());
        scheduleSave();
        return;
      }

      // "- ", "* ", "1. ", or "1) " at the start of a line becomes a list.
      // Only the text between the block's start and the caret matters, so this
      // works inside authored data-block containers and in front of existing
      // text — not just in blocks that hold nothing but the marker.
      if (event.key === " " && sel && sel.isCollapsed && anchor) {
        const host = anchor.nodeType === 1 ? anchor : anchor.parentElement;
        if (!host || host.closest("li, ul, ol")) return;
        const block = innermostBlock(anchor);
        // isBlock matches display:table but not table-cell, so a caret in a
        // table's first cell resolves the whole table — never convert that.
        if (block && /^(table|thead|tbody|tfoot|tr)$/i.test(block.tagName)) return;
        const lead = document.createRange();
        // Inline content directly under <body> (a bare text node beside an
        // image, say) has no block; the caret's own node is the line then.
        if (block) lead.selectNodeContents(block);
        else lead.setStart(anchor, 0);
        try {
          lead.setEnd(sel.anchorNode, sel.anchorOffset);
        } catch {
          return;
        }
        const command = listCommandFor(lead.toString());
        if (!command) return;
        const target = targetFor(anchor);
        event.preventDefault();
        event.stopPropagation();
        userEdited = true;
        if (target) captureOriginal(target.el);
        sel.removeAllRanges();
        sel.addRange(lead);
        document.execCommand("delete");
        document.execCommand(command);
        polishNewList(document.getSelection());
        scheduleSave();
      }
    },
    true
  );

  // ------------------------------------------------------------- image drag

  // Chromium moves an image dropped inside contenteditable on its own; this
  // code only aims the drop (indicator outline), blocks payloads that have
  // nowhere to go (files from the desktop), and writes the edit rows for the
  // block the image left and the block it landed in.
  let dragging = null; // { el, fromBlock, fromLabel, overBlock, dropped } during an image drag

  document.addEventListener("dragstart", (event) => {
    if (reviewMode !== "edit") return;
    const img = event.target && event.target.nodeType === 1 && event.target.tagName === "IMG" ? event.target : null;
    if (!img || isOurs(img)) return;
    const target = targetFor(img);
    if (target) captureOriginal(target.el);
    dragging = {
      el: img,
      src: img.src,
      // The rendered size often comes from the container being left behind
      // (figure/card CSS); remember it so the move can't balloon the image.
      width: img.getBoundingClientRect().width,
      fromBlock: target ? target.el : null,
      fromLabel: target ? target.label : "Image",
      overBlock: null,
      dropped: false,
    };
  });

  document.addEventListener("dragover", (event) => {
    if (reviewMode !== "edit") return;
    if (!dragging) {
      // External payloads would navigate the frame or paste file:// markup.
      if (event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files")) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "none";
      }
      return;
    }
    const range = caretRangeAt(event.clientX, event.clientY);
    const block = range ? innermostBlock(range.startContainer) : null;
    if (block && !isOurs(block)) {
      captureOriginal(block);
      dragging.overBlock = block;
    }
    place(els.outline, block && !isOurs(block) ? block : null);
  });

  const finalizeImageDrag = () => {
    const drag = dragging;
    if (!drag || !drag.dropped) return;
    dragging = null;
    place(els.outline, null);
    // Chrome re-inserts a copy on drop, so find the landed image by source,
    // then pin it to the size it had before the move — an image dragged out
    // of the container that was constraining it would otherwise render at
    // its natural size.
    let landed = drag.el.isConnected ? drag.el : null;
    if (!landed && drag.overBlock && drag.overBlock.isConnected) {
      landed = [...drag.overBlock.querySelectorAll("img")].find((i) => i.src === drag.src) || null;
    }
    if (landed && drag.width && Math.abs(landed.getBoundingClientRect().width - drag.width) > 1) {
      landed.style.width = `${Math.round(drag.width)}px`;
      landed.style.height = "auto";
      landed.style.maxWidth = "100%";
    }
    const rows = new Map();
    if (drag.fromBlock) rows.set(drag.fromBlock, drag.fromLabel);
    if (drag.overBlock && !rows.has(drag.overBlock)) rows.set(drag.overBlock, null);
    for (const [block, label] of rows) emitBlockEdit(block, label);
    scheduleSave();
  };

  document.addEventListener("drop", (event) => {
    if (reviewMode !== "edit") return;
    if (dragging) {
      // The move itself is the drop's default action, so the edit rows can
      // only be read after it has run.
      userEdited = true;
      dragging.dropped = true;
      setTimeout(finalizeImageDrag, 0);
      return;
    }
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) event.preventDefault();
  });

  document.addEventListener("dragend", () => {
    // A cancelled drag (Esc, or dropped outside the page) still needs cleanup.
    if (dragging && !dragging.dropped) {
      dragging = null;
      place(els.outline, null);
    }
  });

  // ------------------------------------------------------------- block moves

  // The handle on a block's left edge moves the whole block. Pointer-based,
  // not HTML5 drag: the element is relocated on drop, never cloned, so
  // identity (labels, captured originals, comment anchors) survives the move.
  let moving = null; // { el, label, drop: { ref, before } | null } while the handle is held
  const cancelMove = () => {
    if (!moving) return;
    moving.preview.cancel();
    moving = null;
    showDropline(null);
    showMover(null);
  };
  window.addEventListener("pointercancel", cancelMove);
  window.addEventListener("blur", cancelMove);

  const dropPointFor = (x, y) => {
    const under = document.elementFromPoint(x, y);
    if (!under || isOurs(under)) return null;
    const block = innermostBlock(under);
    if (!block || block === moving.el || moving.el.contains(block)) return null;
    const r = block.getBoundingClientRect();
    return { ref: block, before: y < r.top + r.height / 2 };
  };

  els.mover.addEventListener("pointerdown", (event) => {
    if (reviewMode !== "edit") return;
    const el = hoverMove && hoverMove.isConnected ? hoverMove : hoverTarget;
    if (!el || !el.isConnected) return;
    event.preventDefault();
    event.stopPropagation();
    const target = targetFor(el);
    moving = {
      el, label: target ? target.label : "Block", drop: null,
      before: el.textContent, beforeHtml: blockHtml(el),
      preview: el.animate([{ opacity: 0.4 }, { opacity: 0.4 }], { duration: 1000, iterations: Infinity }),
    };
    captureOriginal(moving.el);
    place(els.outline, null);
    showChip(null);
    try {
      els.mover.setPointerCapture(event.pointerId);
    } catch {
      // Window-level listeners track the move even without capture.
    }
  });

  window.addEventListener("pointermove", (event) => {
    if (!moving) return;
    event.preventDefault();
    moving.drop = dropPointFor(event.clientX, event.clientY);
    showDropline(moving.drop);
  });

  window.addEventListener("pointerup", () => {
    if (!moving) return;
    const { el, label, drop, before, beforeHtml, preview } = moving;
    moving = null;
    showDropline(null);
    showMover(null);
    preview.cancel();
    suppressUntil = Date.now() + 250;
    if (!drop || !drop.ref.isConnected || !el.isConnected) return;
    // Dropping right back where it came from is a no-op, not an edit.
    const next = drop.before ? drop.ref : drop.ref.nextElementSibling;
    if (next === el || (drop.before ? drop.ref.previousElementSibling : drop.ref) === el) return;
    userEdited = true;
    drop.ref.parentNode.insertBefore(el, next);
    const prev = el.previousElementSibling;
    const following = el.nextElementSibling;
    queueEdit({
      label,
      kind: "moved",
      before,
      after: el.textContent,
      before_html: beforeHtml,
      after_html: blockHtml(el),
      moved_after: prev ? clip(prev.textContent, 90) : "",
      moved_before: following ? clip(following.textContent, 90) : "",
    });
    flushSave();
  });

  // ------------------------------------------------------------- image paste

  // Pasted images cross to the chrome page as bytes; the server writes them
  // into assets/ next to the reviewed file and the confirmed relative path
  // comes back to be inserted where the caret was.
  let pasteSeq = 0;
  const pendingPastes = new Map(); // id → collapsed caret range to insert at

  document.addEventListener(
    "paste",
    (event) => {
      if (isOurs(event.target) || reviewMode !== "edit") return;
      const items = event.clipboardData ? [...event.clipboardData.items] : [];
      const images = items.filter((item) => item.kind === "file" && /^image\//.test(item.type));
      if (!images.length) return;
      event.preventDefault();
      event.stopPropagation();
      const sel = document.getSelection();
      const caret = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      for (const item of images) {
        const file = item.getAsFile();
        if (!file) continue;
        pasteSeq += 1;
        const id = `paste_${pasteSeq}`;
        pendingPastes.set(id, caret);
        file.arrayBuffer().then((bytes) => post("eh:asset", { id, assetType: file.type, bytes }));
      }
    },
    true
  );

  const insertPastedImage = (id, src, stagedId) => {
    const caret = pendingPastes.get(id);
    pendingPastes.delete(id);
    userEdited = true;
    const img = document.createElement("img");
    img.setAttribute("src", src);
    img.style.maxWidth = "100%";
    const anchored = caret && caret.startContainer && document.body.contains(caret.startContainer) && !isOurs(caret.startContainer);
    if (anchored) {
      const target = targetFor(caret.startContainer);
      if (target) captureOriginal(target.el);
      caret.collapse(false);
      caret.insertNode(img);
    } else {
      document.body.appendChild(img);
    }
    const landed = targetFor(img);
    emitBlockEdit(landed ? landed.el : img, landed ? landed.label : "Pasted image", {
      ...(stagedId ? { staged_assets: [{ id: stagedId, preview_src: src }] } : {}),
    });
    flushSave();
  };

  document.addEventListener("input", (event) => {
    if (isOurs(event.target) || reviewMode !== "edit") return;
    // A drop fires deleteByDrag/insertFromDrop input events whose selection
    // points anywhere; finalizeImageDrag writes the real rows instead.
    if (dragging) return;
    // Typing over a selection is an edit, not a comment: retire the card.
    if (pending) {
      clearPending();
      post("eh:dismiss", {});
    }
    const sel = document.getSelection();
    const node = sel && sel.anchorNode ? sel.anchorNode : event.target;
    const target = targetFor(node);
    // Text alone loses formatting-only edits (bold, italic, underline change
    // markup, not textContent), so the block's cleaned HTML travels too.
    queueEdit({
      label: target ? target.label : "Document body",
      kind: "edited",
      before: target ? originalText.get(target.el) : undefined,
      after: target ? target.el.textContent : undefined,
      before_html: target ? originalHtml.get(target.el) : undefined,
      after_html: target ? blockHtml(target.el) : undefined,
    });
    scheduleSave();
  });

  const reposition = () => {
    hoverIntent.cancel();
    place(els.outline, hoverTarget);
    renderBlockAnnotations();
    if (reviewMode === "edit" && !controlsAreSuppressed()) {
      showChip(hoverTarget);
      showMover(moving ? null : hoverMove);
      showGrip(resizing ? resizing.el : hoverMedia);
    } else {
      hideActionControls();
      showGrip(null);
    }
    scheduleTargetGeometry();
    if (activeCommentId) activate(activeCommentId, false);
    // Recovery notices can resize the frame. Re-anchor without discarding the
    // open editor's draft or focus; only a missing/invisible target invalidates it.
    if (linkState) positionLinkbox();
  };
  // getBoundingClientRect on every scroll event forces layout mid-scroll;
  // one reposition per frame is plenty.
  let repositionQueued = false;
  const scheduleReposition = () => {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(() => {
      repositionQueued = false;
      reposition();
    });
  };
  document.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("scroll", scheduleReposition, true);
  window.addEventListener("resize", scheduleReposition);

  let scrollQueued = false;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        post("eh:scroll", { x: window.scrollX, y: window.scrollY });
      });
    },
    { passive: true }
  );

  window.addEventListener("message", (event) => {
    // Only the chrome page may drive the SDK — not popups the artifact opened,
    // and not the artifact's own scripts.
    if (event.source !== window.parent || event.origin !== CHROME_ORIGIN) return;
    const msg = event.data || {};
    if (!matchesFrameMessage(msg)) return;
    switch (msg.type) {
      case "eh:threadAnchors":
        try { threadAnchors.project(msg); refreshGeometryWatch(); }
        catch (error) { diagnostic("thread-boundary-rejected", { message: error.message }); }
        break;
      case "eh:threadAction":
        try {
          const action = threadAnchors.action(msg);
          if (action.action === "dismiss") deactivateComment();
          else {
            if (action.action === "reveal") targetElement(threadTargets.get(action.threadId))?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            activate(action.threadId, false);
            threadAnchors.refresh();
          }
        } catch (error) { diagnostic("thread-boundary-rejected", { message: error.message }); }
        break;
      case "eh:setTheme":
        applyReviewTheme(msg);
        break;
      case "eh:anchors":
        if (!threadAnchors.projection) reanchor(msg.comments || []);
        break;
      case "eh:commit":
        if (msg.targetGeneration && pending && msg.targetGeneration !== pending.generation) break;
        commitPending(msg.id, msg.targetGeneration, { restoreFocus: !!msg.restoreFocus });
        composeOpen = false;
        break;
      case "eh:cancel":
        if (msg.targetGeneration && pending && msg.targetGeneration !== pending.generation) break;
        {
          const discardThrough = Number(msg.discardThroughGeneration) || Number(msg.targetGeneration) || 0;
          retiredComposeGeneration = Math.max(retiredComposeGeneration, discardThrough);
          if (commentOpenRequestGeneration <= discardThrough) commentOpenRequestGeneration = null;
          const newerRetarget = retarget && retarget.generation > discardThrough ? retarget : null;
          if (msg.restoreFocus && !newerRetarget) restoreTargetFocus(pending);
          clearPending({ keepRetarget: !!newerRetarget || !!msg.preserveRetarget });
          if (newerRetarget) {
            pending = newerRetarget;
            retarget = null;
          }
        }
        composeOpen = false;
        if (pending) {
          observePendingTarget(pending);
          scheduleTargetGeometry();
        }
        break;
      case "eh:commentOpenResult":
        acceptCommentOpen(msg);
        break;
      case "eh:deactivateComment":
        deactivateComment();
        break;
      case "eh:revealTarget":
        revealTarget(msg.targetGeneration);
        break;
      case "eh:modeMenuState":
        modeMenuOpen = !!msg.open;
        hoverIntent.reset();
        break;
      case "eh:remove":
        unwrap(msg.id);
        blockTargets.delete(msg.id);
        if (activeCommentId === msg.id) activeCommentId = null;
        place(els.activeBox, null);
        renderBlockAnnotations();
        break;
      case "eh:activate":
        if (!threadAnchors.projection) activate(msg.id, !!msg.scroll);
        break;
      case "eh:flush":
        flushSave();
        // Posted after the flushed eh:edit/eh:html messages, so when the
        // chrome sees it, everything pending has already been handed over.
        post("eh:flushed", {
          ...(typeof msg.requestId === "string" && msg.requestId.length > 0 && msg.requestId.length <= 128
            ? { requestId: msg.requestId }
            : {}),
        });
        break;
      case "eh:captureSnapshot":
        void captureSnapshot(msg);
        break;
      case "eh:historyJump":
        jumpToHistoryTarget(msg);
        break;
      case "eh:abortSave":
        // A revert is in flight: anything queued would re-write the edits.
        clearTimeout(saveTimer);
        clearTimeout(editTimer);
        editQueue.clear();
        break;
      case "eh:raw":
        if (savePolicy === "writable") checkDynamic(String(msg.html || ""));
        break;
      case "eh:configureReview": {
        cancelHover();
        reviewMode = msg.mode === "edit" ? "edit" : "view";
        savePolicy = msg.savePolicy === "feedback-only" ? "feedback-only" : "writable";
        modeController.setMode(reviewMode);
        if (reviewMode === "view") {
          showChip(null);
          showMover(null);
          showGrip(null);
          els.linkbox.style.display = "none";
        }
        scheduleTargetGeometry();
        post("eh:configurationApplied", { mode: reviewMode, savePolicy });
        break;
      }
      case "eh:restoreScroll":
        window.scrollTo(msg.x || 0, msg.y || 0);
        break;
      case "eh:assetSaved":
        insertPastedImage(msg.id, String(msg.src || ""), String(msg.stagedId || ""));
        break;
      case "eh:assetFailed":
        pendingPastes.delete(msg.id);
        break;
      case "eh:submittedEdits": {
        if (!Array.isArray(msg.labels) || msg.labels.some((label) => typeof label !== "string")) break;
        const labels = new Set(msg.labels);
        for (const element of capturedBlocks) if (labels.has(pinnedLabels.get(element))) {
          originalText.delete(element);
          originalHtml.delete(element);
          capturedBlocks.delete(element);
        }
        break;
      }
      default:
        break;
    }
  });

  post("eh:ready", { scrollHeight: document.body.scrollHeight });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
