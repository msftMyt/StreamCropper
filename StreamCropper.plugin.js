/**
 * @name StreamCropper
 * @author msftMyt
 * @version 1.0.0
 * @description Crops ultrawide and multi-monitor screen shares at the MediaStream level so Discord treats the cropped area like a native video source.
 * @website https://github.com/msftMyt/StreamCropper
 * @source https://github.com/msftMyt/StreamCropper/blob/main/StreamCropper.plugin.js
 */

/*
 * Why MediaStream cropping instead of CSS `clip-path` / `transform`?
 *
 * Discord's player reads `video.videoWidth` and `video.videoHeight` to compute
 * flex aspect-ratio wrappers, letterbox bounds, popout dimensions, and its
 * built-in zoom/pan controls. If someone shares a 32:9 ultrawide monitor
 * (5120x1440) and you try to crop it purely with CSS on `<video>`, Discord
 * still thinks the stream is 32:9 and clamps it inside a short horizontal
 * wrapper box with black bars all around it.
 *
 * Instead, this plugin crops the live WebRTC video track itself (using
 * Chromium's WebCodecs `MediaStreamTrackProcessor` + `VideoFrame` visibleRect,
 * falling back to `canvas.captureStream`) and feeds the resulting MediaStream
 * into `video.srcObject`. Discord sees a genuine 2560x1440 (or custom-sized)
 * stream and handles stage layout, fullscreen, popout, and native zoom on its own.
 */

(function () {
  "use strict";

  const PLUGIN_NAME = "StreamCropper";
  const STYLE_ID = "dsc-stream-cropper-styles";

  const MAX_SAVED_PRESETS = 6;
  const MAX_REMEMBERED_STREAMS = 96;

  // Ignore small voice-call avatar loops, nitro badges, and bottom bar preview tiles.
  const MIN_STAGE_VIDEO_WIDTH = 200;
  const MIN_STAGE_VIDEO_HEIGHT = 150;
  const MIN_MINIPLAYER_WIDTH = 140;
  const MIN_MINIPLAYER_HEIGHT = 80;
  const COMPACT_HOST_WIDTH = 360;
  const COMPACT_HOST_HEIGHT = 220;
  const MODAL_ONLY_HOST_WIDTH = 340;

  // Minimum normalized selection size so WebCodecs never allocates zero-area frames.
  const MIN_CROP_FRACTION = 0.08;

  // Track streams we created without tacking custom properties onto MediaStream objects.
  const CROPPED_STREAMS = new WeakSet();

  const FULL_REGION = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

  const DEFAULT_SETTINGS = Object.freeze({
    buttonPosition: "top-right",
    rememberPerStreamer: true,
    autoCenterUltrawide: false,
    defaultSliceAspect: "16:9",
    showResolutionBadge: true
  });

  function logWarn(message, err) {
    if (typeof BdApi !== "undefined" && BdApi.Logger?.warn) {
      BdApi.Logger.warn(PLUGIN_NAME, message, err ?? "");
    } else {
      console.warn(`[${PLUGIN_NAME}] ${message}`, err ?? "");
    }
  }

  const ASPECT_RATIOS = Object.freeze({
    "16:9": 16 / 9,
    "21:9": 21 / 9,
    "4:3": 4 / 3,
    "1:1": 1
  });

  // Inline SVGs so we don't depend on external icon URLs blocked by Discord's CSP.
  const ICONS = {
    crop: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>`,
    draw: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    bookmark: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`
  };

  const STYLES = `
    .dsc-host-positioned {
      position: relative !important;
    }

    .dsc-root {
      position: absolute;
      inset: 0;
      pointer-events: none;
      z-index: 90;
      font-family: "gg sans", "Noto Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f2f3f5;
      user-select: none;
    }

    .dsc-root *,
    .dsc-draw-modal,
    .dsc-draw-modal * {
      box-sizing: border-box;
    }

    .dsc-trigger {
      position: absolute;
      top: 12px;
      right: 12px;
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 11px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.13);
      background: rgba(17, 18, 20, 0.78);
      backdrop-filter: blur(10px);
      color: #e3e5e8;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      opacity: 0;
      transform: translateY(-2px);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.42);
      transition: opacity 0.16s ease, transform 0.16s ease, background-color 0.14s ease, border-color 0.14s ease;
    }

    .dsc-root.dsc-pos-top-left .dsc-trigger {
      right: auto;
      left: 12px;
    }

    .dsc-host-hover .dsc-trigger,
    .dsc-root.dsc-open .dsc-trigger,
    .dsc-trigger.dsc-is-cropped {
      opacity: 0.84;
      transform: translateY(0);
    }

    .dsc-trigger:hover,
    .dsc-trigger:focus-visible,
    .dsc-root.dsc-open .dsc-trigger {
      opacity: 1 !important;
      background: rgba(24, 25, 28, 0.96);
      border-color: rgba(88, 101, 242, 0.9);
      color: #ffffff;
      outline: none;
    }

    .dsc-trigger-res {
      font-size: 10.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: #b5bac1;
      padding-left: 2px;
    }

    .dsc-trigger.dsc-is-cropped .dsc-trigger-res {
      color: #99a2ff;
    }

    .dsc-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #5865f2;
      box-shadow: 0 0 6px #5865f2;
      display: none;
    }

    .dsc-trigger.dsc-is-cropped .dsc-dot {
      display: inline-block;
    }

    .dsc-root.dsc-compact .dsc-trigger {
      top: 6px;
      right: 6px;
      height: 24px;
      padding: 0 8px;
      gap: 5px;
      font-size: 11px;
    }

    .dsc-root.dsc-compact.dsc-pos-top-left .dsc-trigger {
      right: auto;
      left: 6px;
    }

    .dsc-root.dsc-compact .dsc-trigger-res {
      display: none;
    }

    .dsc-hud {
      position: absolute;
      top: 48px;
      right: 12px;
      width: 336px;
      max-width: calc(100% - 24px);
      pointer-events: auto;
      background: rgba(17, 18, 20, 0.94);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 11px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.68);
      display: none;
      flex-direction: column;
      gap: 9px;
    }

    .dsc-root.dsc-pos-top-left .dsc-hud {
      right: auto;
      left: 12px;
    }

    .dsc-root.dsc-open .dsc-hud {
      display: flex;
    }

    .dsc-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .dsc-title-wrap {
      display: flex;
      align-items: baseline;
      gap: 7px;
      min-width: 0;
    }

    .dsc-title {
      font-size: 12.5px;
      font-weight: 700;
      color: #f2f3f5;
    }

    .dsc-meta {
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: #949ba4;
      white-space: nowrap;
    }

    .dsc-header-btns {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .dsc-icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      height: 24px;
      min-width: 24px;
      padding: 0 7px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(43, 45, 49, 0.8);
      color: #dbdee1;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }

    .dsc-icon-btn:hover {
      background: rgba(64, 66, 73, 0.95);
      color: #ffffff;
    }

    .dsc-icon-btn.dsc-active {
      background: #5865f2;
      border-color: #5865f2;
      color: #ffffff;
    }

    .dsc-chips {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
    }

    .dsc-chip {
      height: 26px;
      padding: 0 4px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(43, 45, 49, 0.75);
      color: #b5bac1;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
    }

    .dsc-chip:hover {
      background: rgba(64, 66, 73, 0.92);
      color: #f2f3f5;
    }

    .dsc-chip.dsc-selected {
      background: #5865f2;
      border-color: #5865f2;
      color: #ffffff;
    }

    .dsc-minimap {
      position: relative;
      width: 100%;
      background: #0b0c0e;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
      cursor: crosshair;
      touch-action: none;
    }

    .dsc-minimap-canvas {
      display: block;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .dsc-minimap-box {
      position: absolute;
      border: 2px solid #7983f5;
      border-radius: 4px;
      background: rgba(88, 101, 242, 0.14);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.58), inset 0 0 0 1px rgba(255, 255, 255, 0.2);
      cursor: grab;
      touch-action: none;
    }

    .dsc-minimap-box:active {
      cursor: grabbing;
    }

    .dsc-handle {
      position: absolute;
      z-index: 2;
    }

    .dsc-handle-nw { top: -5px; left: -5px; width: 10px; height: 10px; cursor: nwse-resize; }
    .dsc-handle-ne { top: -5px; right: -5px; width: 10px; height: 10px; cursor: nesw-resize; }
    .dsc-handle-sw { bottom: -5px; left: -5px; width: 10px; height: 10px; cursor: nesw-resize; }
    .dsc-handle-se { bottom: -5px; right: -5px; width: 10px; height: 10px; cursor: nwse-resize; }
    .dsc-handle-n  { top: -4px; left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
    .dsc-handle-s  { bottom: -4px; left: 8px; right: 8px; height: 8px; cursor: ns-resize; }
    .dsc-handle-w  { left: -4px; top: 8px; bottom: 8px; width: 8px; cursor: ew-resize; }
    .dsc-handle-e  { right: -4px; top: 8px; bottom: 8px; width: 8px; cursor: ew-resize; }

    .dsc-handle-nw::after,
    .dsc-handle-ne::after,
    .dsc-handle-sw::after,
    .dsc-handle-se::after {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: 2px;
      background: #ffffff;
      border: 1px solid #5865f2;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }

    .dsc-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }

    .dsc-draw-full-btn {
      flex: 1;
      height: 26px;
      justify-content: center;
      background: rgba(88, 101, 242, 0.16);
      border-color: rgba(88, 101, 242, 0.5);
      color: #dee0fc;
    }

    .dsc-draw-full-btn:hover {
      background: #5865f2;
      border-color: #5865f2;
      color: #ffffff;
    }

    .dsc-saved-row {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
      padding-top: 5px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    .dsc-saved-pill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(43, 45, 49, 0.68);
      overflow: hidden;
    }

    .dsc-saved-apply,
    .dsc-saved-del {
      border: none;
      background: transparent;
      color: #dbdee1;
      font-family: inherit;
      cursor: pointer;
      height: 100%;
      display: inline-flex;
      align-items: center;
    }

    .dsc-saved-apply {
      padding: 0 6px 0 8px;
      font-size: 10.5px;
      font-weight: 600;
    }

    .dsc-saved-apply:hover,
    .dsc-saved-apply:focus-visible {
      background: rgba(88, 101, 242, 0.35);
      color: #ffffff;
      outline: none;
    }

    .dsc-saved-del {
      padding: 0 7px 0 4px;
      opacity: 0.65;
      font-size: 12px;
      line-height: 1;
    }

    .dsc-saved-del:hover,
    .dsc-saved-del:focus-visible {
      opacity: 1;
      color: #ff7b7f;
      outline: none;
    }

    .dsc-icon-btn:focus-visible,
    .dsc-chip:focus-visible,
    .dsc-minimap:focus-visible {
      outline: 2px solid #5865f2;
      outline-offset: 1px;
    }

    .dsc-draw-modal {
      position: fixed;
      inset: 0;
      z-index: 2147483640;
      background: rgba(10, 11, 13, 0.86);
      backdrop-filter: blur(8px);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 28px;
      user-select: none;
    }

    .dsc-draw-modal-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(24, 25, 28, 0.95);
      border: 1px solid rgba(88, 101, 242, 0.75);
      color: #f2f3f5;
      font-family: "gg sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12.5px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    }

    .dsc-draw-stage {
      position: relative;
      max-width: 92vw;
      max-height: 80vh;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.15);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.75);
      cursor: crosshair;
      touch-action: none;
    }

    .dsc-draw-stage-canvas {
      display: block;
      max-width: 92vw;
      max-height: 80vh;
      pointer-events: none;
    }

    .dsc-draw-selection {
      position: absolute;
      border: 2px solid #7983f5;
      border-radius: 4px;
      background: rgba(88, 101, 242, 0.14);
      box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6);
      pointer-events: none;
      display: none;
    }

    .dsc-draw-readout {
      position: absolute;
      left: 0;
      bottom: -24px;
      padding: 2px 7px;
      border-radius: 4px;
      background: #1e1f22;
      border: 1px solid #5865f2;
      color: #f2f3f5;
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
  `;

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  function roundDownEven(value, minEven = 2) {
    const n = Math.max(minEven, Math.round(value));
    return n % 2 === 0 ? n : n - 1;
  }

  function normalizeRegion({ x = 0, y = 0, w = 1, h = 1 } = {}) {
    const width = clamp(Number(w) || 1, MIN_CROP_FRACTION, 1);
    const height = clamp(Number(h) || 1, MIN_CROP_FRACTION, 1);
    return {
      x: clamp(Number(x) || 0, 0, 1 - width),
      y: clamp(Number(y) || 0, 0, 1 - height),
      w: width,
      h: height
    };
  }

  function isFullRegion(region) {
    return !region || (region.x <= 0.002 && region.y <= 0.002 && region.w >= 0.996 && region.h >= 0.996);
  }

  function isMediaStream(val, win) {
    if (!val || typeof val !== "object") return false;
    return (
      (typeof MediaStream !== "undefined" && val instanceof MediaStream) ||
      Boolean(win?.MediaStream && val instanceof win.MediaStream) ||
      (typeof val.getVideoTracks === "function" && typeof val.getAudioTracks === "function")
    );
  }

  function requestAnimFrame(win, cb) {
    const fn = win?.requestAnimationFrame ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
    return fn ? fn.call(win, cb) : setTimeout(() => cb(Date.now()), 16);
  }

  function cancelAnimFrame(win, id) {
    if (!id) return;
    const fn = win?.cancelAnimationFrame ?? (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);
    if (fn) fn.call(win, id);
    else clearTimeout(id);
  }

  function getActiveFullscreenElement(doc) {
    return doc?.fullscreenElement || doc?.webkitFullscreenElement || null;
  }

  // When Discord enters Fullscreen, elements appended to `document.body` render
  // behind the browser's Fullscreen Top Layer. Mount inside the active fullscreen
  // container instead — unless `<video>` itself is the fullscreen leaf element
  // (which cannot render child `<div>` overlays), falling back to its parent/body.
  function getModalMountTarget(doc) {
    const fsEl = getActiveFullscreenElement(doc);
    if (fsEl) {
      if (fsEl.nodeName === "VIDEO") {
        return fsEl.parentElement || doc.body || doc.documentElement;
      }
      return fsEl;
    }
    return doc?.body || doc?.documentElement || null;
  }

  const BADGE_NOISE_RE = /^(LIVE|HD|FHD|QHD|4K|1080p|720p|1440p|2160p|60|30|FPS|•|'s\s*screen|’s\s*screen|watch\s*stream|stop\s*watching|pop\s*out|disconnect|mute|unmute|deafen|undeafen|crop|source\s*crop|reset|full|left|center|right|save|cancel.*|reset\s+to\s+full.*|draw\s+custom.*|stream\s+preview|turn\s+on\s+camera|share\s+your\s+screen|invite\s+friends|nitro|boosted|\d+\s*(viewers?|watching)|\d+[:x×]\d+.*|\d{1,2}:\d{2}(:\d{2})?|\d+p\s*\d*(fps)?)$/i;

  function isValidStreamerLabel(raw) {
    const text = String(raw ?? "").trim();
    return text.length >= 2 && text.length <= 32 && !BADGE_NOISE_RE.test(text);
  }

  function isIgnoredOverlayOrInteractiveNode(el, excludeRoot = null) {
    let cur = el;
    while (cur) {
      if (excludeRoot && cur === excludeRoot) return true;
      const cls = cur.classList;
      if (cls?.contains?.("dsc-root") || cls?.contains?.("dsc-draw-modal")) return true;
      const tag = cur.nodeName;
      if (tag === "BUTTON") return true;
      const role = cur.getAttribute?.("role");
      if (role === "button" || role === "tooltip" || role === "dialog") return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // Extract ordered streamer label candidates without relying on hashed Discord classes.
  // Handles both stage overlay badges (`beh.`) and popout/stage header bars (`channel • beh. • 's Screen`)
  // while ignoring interactive controls, tooltips, our own HUD, and sibling multi-stream tiles!
  function extractStreamerLabels(container, doc = null, excludeRoot = null) {
    const headerLabels = [];
    const badgeLabels = [];

    const addUnique = (target, val) => {
      const clean = String(val ?? "").trim().toLowerCase();
      if (isValidStreamerLabel(clean) && !headerLabels.includes(clean) && !badgeLabels.includes(clean)) {
        target.push(clean);
      }
    };

    // 1) High-precision Header check: look for `<name>` immediately preceding `'s Screen`
    // In Popouts with <=1 video, inspect `doc.body`; in Main Window (or multi-video), walk up
    // up to 3 single-video ancestors above `container` so we catch top stage headers without
    // cross-contaminating side-by-side multi-stream tiles!
    let headerScope = container;
    if (doc?.body && (doc.querySelectorAll?.("video")?.length ?? 0) <= 1) {
      headerScope = doc.body;
    } else if (container) {
      let anc = container;
      for (let d = 0; d < 3 && anc?.parentElement && anc.parentElement !== doc?.body; d++) {
        if ((anc.parentElement.querySelectorAll?.("video")?.length ?? 0) > 1) break;
        anc = anc.parentElement;
      }
      headerScope = anc;
    }

    if (headerScope?.querySelectorAll) {
      const leafTexts = [];
      for (const el of headerScope.querySelectorAll("span, div, h1, h2, h3")) {
        if (isIgnoredOverlayOrInteractiveNode(el, excludeRoot)) continue;
        if (el.children.length > 0) continue;
        const txt = el.textContent?.trim() ?? "";
        if (txt) leafTexts.push({ el, txt });
      }

      for (let i = 0; i < leafTexts.length; i++) {
        const cur = leafTexts[i].txt;
        const inlineMatch = cur.match(/^(.+?)(?:'s|’s)\s+screen$/i);
        if (inlineMatch && inlineMatch[1]) {
          const parts = inlineMatch[1].split("•").map((s) => s.trim()).filter(Boolean);
          if (parts.length) addUnique(headerLabels, parts[parts.length - 1]);
        } else if (/^(?:'s|’s)\s*screen$/i.test(cur)) {
          for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
            const prev = leafTexts[j].txt;
            if (prev === "•" || prev === "·" || prev === "-") continue;
            addUnique(headerLabels, prev);
            break;
          }
        }
      }
    }

    // 2) Stage overlay badges inside `container` (scanning bottom-up since Discord places
    // the streamer name pill in the bottom-left of the video stage!)
    if (container?.querySelectorAll) {
      const stageLeaves = [];
      for (const el of container.querySelectorAll("span, div")) {
        if (isIgnoredOverlayOrInteractiveNode(el, excludeRoot)) continue;
        if (el.children.length > 0) continue;
        const txt = el.textContent?.trim() ?? "";
        if (isValidStreamerLabel(txt)) {
          stageLeaves.push(txt);
        }
      }
      for (let i = stageLeaves.length - 1; i >= 0; i--) {
        addUnique(badgeLabels, stageLeaves[i]);
      }
    }

    if (doc?.title) {
      const titleMatch = doc.title.match(/^(.+?)(?:'s|’s)\s+screen/i);
      if (titleMatch?.[1]) addUnique(headerLabels, titleMatch[1]);
    }

    return [...headerLabels, ...badgeLabels];
  }

  function buildStreamIdentities(stream, intrinsicDims, streamerLabels = []) {
    const sessionKeys = [];
    const streamerKeys = [];
    const fallbackKeys = [];

    if (stream) {
      if (stream.id) sessionKeys.push(`stream:${stream.id}`);
      const [vTrack] = stream.getVideoTracks?.() ?? [];
      if (vTrack?.id) sessionKeys.push(`track:${vTrack.id}`);
    }

    const width = Number(intrinsicDims?.width) || 0;
    const height = Number(intrinsicDims?.height) || 0;
    const hasDims = width > 0 && height > 0;

    const rawList = Array.isArray(streamerLabels)
      ? streamerLabels
      : streamerLabels
        ? [streamerLabels]
        : [];
    const cleanLabels = [];

    for (const rawLabel of rawList) {
      const label = String(rawLabel ?? "").trim().toLowerCase();
      if (!label || cleanLabels.includes(label)) continue;
      cleanLabels.push(label);
      if (hasDims) streamerKeys.push(`streamer:${label}|${width}x${height}`);
      streamerKeys.push(`streamer:${label}`);
    }

    if (hasDims && width / Math.max(1, height) > 2.05) {
      fallbackKeys.push(`ultrawide-res:${width}x${height}`);
      fallbackKeys.push(`ultrawide-aspect:${(width / height).toFixed(2)}`);
    }

    return {
      sessionKeys,
      streamerKeys,
      fallbackKeys,
      persistentKeys: [...streamerKeys, ...fallbackKeys],
      width,
      height,
      primaryStreamer: cleanLabels[0] ?? ""
    };
  }

  function resolvePlayerHostForVideo(video, doc) {
    const immediate = video?.parentElement;
    if (!immediate) return null;

    const fsEl = getActiveFullscreenElement(doc);
    if (fsEl && fsEl !== video && fsEl.contains?.(video)) {
      if (fsEl.querySelectorAll("video").length <= 1) {
        return fsEl;
      }
    }

    let best = immediate;
    let cur = immediate;

    for (let depth = 0; depth < 8 && cur && cur !== doc.body && cur !== doc.documentElement; depth++) {
      if (cur.querySelectorAll("video").length > 1) break;

      if (cur !== immediate && cur.children.length > 1) {
        let hasChromeOrParticipantSibling = false;
        for (const child of cur.children) {
          if (child.contains(video)) continue;
          const cr = child.getBoundingClientRect();
          const cw = child.clientWidth || cr.width;
          const ch = child.clientHeight || cr.height;
          // Stop before climbing into outer shells holding either the bottom participant
          // tile strip (ch >= 95) OR a full-width top window/popout header bar (ch 22..94)
          // when the sibling sits outside the video box!
          if (cw > 300 && ch >= 95) {
            hasChromeOrParticipantSibling = true;
            break;
          }
          if (cw > 300 && ch >= 20 && ch < 95 && child.textContent?.includes("Screen")) {
            hasChromeOrParticipantSibling = true;
            break;
          }
        }
        if (hasChromeOrParticipantSibling) break;
      }

      const rect = cur.getBoundingClientRect();
      const w = cur.clientWidth || rect.width;
      const h = cur.clientHeight || rect.height;
      if (w >= MIN_MINIPLAYER_WIDTH && h >= MIN_MINIPLAYER_HEIGHT) {
        best = cur;
      }

      if (fsEl && cur === fsEl) break;
      cur = cur.parentElement;
    }

    return best;
  }

  function isStandaloneMiniPlayerVideo(video, doc) {
    const immediate = video?.parentElement;
    if (!immediate || immediate.querySelectorAll("video").length > 1) return false;

    let cur = immediate.parentElement;
    for (let depth = 0; depth < 3 && cur && cur !== doc.body && cur !== doc.documentElement; depth++) {
      if (cur.querySelectorAll("video").length > 1) {
        const rect = cur.getBoundingClientRect();
        const cw = cur.clientWidth || rect.width;
        const ch = cur.clientHeight || rect.height;
        // Multi-video participant tile grids sit inside a compact shared call grid box rather
        // than the outer app shell; use 520x360 so half-screen snapped 1080p windows (960px) work!
        if (cw > 0 && ch > 0 && (cw < 520 || ch < 360)) {
          return false;
        }
        break;
      }
      cur = cur.parentElement;
    }

    return true;
  }

  // Chromium's VideoFrame visibleRect requires even X/Y/width/height when the
  // underlying WebRTC decoder outputs 4:2:0 (I420 / NV12) planes; odd offsets
  // throw a DOMException on sub-sampled chroma planes. `originX`/`originY`
  // account for hardware decoders whose `visibleRect` starts at a non-zero offset.
  function computePixelCropRect(region, frameWidth, frameHeight, originX = 0, originY = 0) {
    const norm = normalizeRegion(region);
    const fw = Math.max(4, Math.floor(Number(frameWidth) || 1920));
    const fh = Math.max(4, Math.floor(Number(frameHeight) || 1080));
    const ox = Math.max(0, Math.floor(Number(originX) || 0));
    const oy = Math.max(0, Math.floor(Number(originY) || 0));
    const evenOx = ox + (ox % 2);
    const evenOy = oy + (oy % 2);

    const maxEvenW = Math.max(2, (ox + fw - evenOx) - ((ox + fw - evenOx) % 2));
    const maxEvenH = Math.max(2, (oy + fh - evenOy) - ((oy + fh - evenOy) % 2));

    const width = clamp(roundDownEven(norm.w * fw, 16), 2, maxEvenW);
    const height = clamp(roundDownEven(norm.h * fh, 16), 2, maxEvenH);

    let x = ox + Math.round(norm.x * fw);
    let y = oy + Math.round(norm.y * fh);
    if (x % 2 !== 0) x -= 1;
    if (y % 2 !== 0) y -= 1;

    x = clamp(x, evenOx, ox + fw - width);
    y = clamp(y, evenOy, oy + fh - height);
    if (x % 2 !== 0) x = Math.max(evenOx, x - 1);
    if (y % 2 !== 0) y = Math.max(evenOy, y - 1);

    return { x, y, width, height };
  }

  // On ultrawide streams (e.g. 5120x1440), Left / Center / Right carve out an exact
  // 16:9 slice (2560x1440); on standard 16:9 streams, they grab half the width.
  function computeSourcePreset(presetId, streamAspect, defaultSliceAspect = "16:9") {
    if (presetId === "full") return { ...FULL_REGION };

    const sliceAspect = ASPECT_RATIOS[defaultSliceAspect] ?? 16 / 9;

    if (presetId === "16:9" || presetId === "21:9") {
      const target = ASPECT_RATIOS[presetId];
      if (streamAspect > target * 1.01) {
        const w = clamp(target / streamAspect, MIN_CROP_FRACTION, 1);
        return normalizeRegion({ x: (1 - w) / 2, y: 0, w, h: 1 });
      }
      if (streamAspect < target * 0.99) {
        const h = clamp(streamAspect / target, MIN_CROP_FRACTION, 1);
        return normalizeRegion({ x: 0, y: (1 - h) / 2, w: 1, h });
      }
      return { ...FULL_REGION };
    }

    const w = streamAspect > sliceAspect * 1.08
      ? clamp(sliceAspect / streamAspect, MIN_CROP_FRACTION, 0.9)
      : 0.5;

    if (presetId === "left") return normalizeRegion({ x: 0, y: 0, w, h: 1 });
    if (presetId === "center") return normalizeRegion({ x: (1 - w) / 2, y: 0, w, h: 1 });
    if (presetId === "right") return normalizeRegion({ x: 1 - w, y: 0, w, h: 1 });

    return { ...FULL_REGION };
  }

  // Wraps a live WebRTC MediaStream and outputs a new MediaStream cropped to
  // `this.region`. Updating `this.region` mutates the crop on the fly for the
  // next frame without rebuilding the stream or re-assigning `srcObject`.
  class MediaStreamCropSession {
    #abort = null;
    #trackAbort = null;
    #generator = null;
    #hiddenVideo = null;
    #rafId = 0;
    #onStreamReplaced;
    #onVideoTrackEnded;

    constructor(
      sourceStream,
      initialRegion,
      { onStreamReplaced = null, onVideoTrackEnded = null, doc = document, win = null } = {}
    ) {
      this.sourceStream = sourceStream;
      this.region = normalizeRegion(initialRegion);
      this.doc = doc || document;
      this.win = win || this.doc.defaultView || window;
      this.outputStream = null;
      this.mode = "none";
      this.disposed = false;
      this.lastSourceSize = { width: 0, height: 0 };
      this.lastOutputSize = { width: 0, height: 0 };
      this.#onStreamReplaced = onStreamReplaced;
      this.#onVideoTrackEnded = onVideoTrackEnded;
    }

    static supportsWebCodecs(win = null) {
      // Prefer the main BetterDiscord realm's WebCodecs constructors first:
      // Discord creates all WebRTC MediaStreamTracks in the main window's peer connection,
      // so constructing Processor/Generator/MediaStream in the main realm avoids cross-realm
      // track/stream TypeErrors inside `about:blank` popout windows!
      const ProcessorCtor = (typeof MediaStreamTrackProcessor === "function" ? MediaStreamTrackProcessor : null) ?? win?.["MediaStreamTrackProcessor"];
      const GeneratorCtor = (typeof MediaStreamTrackGenerator === "function" ? MediaStreamTrackGenerator : null) ?? win?.["MediaStreamTrackGenerator"];
      const FrameCtor = (typeof VideoFrame === "function" ? VideoFrame : null) ?? win?.["VideoFrame"];
      return (
        typeof ProcessorCtor === "function" &&
        typeof GeneratorCtor === "function" &&
        typeof FrameCtor === "function"
      );
    }

    start() {
      if (this.disposed) return null;
      const [videoTrack] = this.sourceStream.getVideoTracks?.() ?? [];
      if (!videoTrack) return this.sourceStream;

      const audioTracks = this.sourceStream.getAudioTracks?.() ?? [];

      let out = null;
      if (MediaStreamCropSession.supportsWebCodecs(this.win)) {
        try {
          out = this.startWebCodecs(videoTrack, audioTracks);
        } catch (err) {
          logWarn("WebCodecs crop startup failed; falling back to canvas stream.", err);
        }
      }

      if (!out) {
        out = this.startCanvasFallback(audioTracks);
      }

      this.#bindSourceTrackSync(videoTrack);
      return out;
    }

    #bindSourceTrackSync(activeVideoTrack) {
      this.#trackAbort?.abort();
      this.#trackAbort = new AbortController();
      const { signal } = this.#trackAbort;

      // Sync delayed WebRTC screen-share audio tracks (`addtrack` / `removetrack`)
      // so audio added after mount is never muted while cropped!
      if (typeof this.sourceStream?.addEventListener === "function") {
        this.sourceStream.addEventListener(
          "addtrack",
          (e) => {
            if (this.disposed || !e?.track) return;
            if (e.track.kind === "audio") {
              const existing = this.outputStream?.getAudioTracks?.() ?? [];
              if (!existing.includes(e.track)) {
                this.outputStream?.addTrack?.(e.track);
              }
            } else if (e.track.kind === "video" && e.track !== activeVideoTrack) {
              this.#onVideoTrackEnded?.();
            }
          },
          { signal }
        );
        this.sourceStream.addEventListener(
          "removetrack",
          (e) => {
            if (this.disposed || !e?.track) return;
            if (e.track.kind === "audio") {
              this.outputStream?.removeTrack?.(e.track);
            }
          },
          { signal }
        );
      }

      if (typeof activeVideoTrack?.addEventListener === "function") {
        activeVideoTrack.addEventListener(
          "ended",
          () => {
            if (this.disposed) return;
            this.#onVideoTrackEnded?.();
          },
          { once: true, signal }
        );
      }
    }

    setRegion(nextRegion) {
      this.region = normalizeRegion(nextRegion);
    }

    startWebCodecs(videoTrack, audioTracks) {
      // Match the constructor realm of `this.sourceStream` when it belongs to `this.win`
      // (and `this.win` provides full WebCodecs), otherwise use the main plugin realm!
      const useWinRealm =
        this.win &&
        this.win !== window &&
        this.win["MediaStream"] &&
        this.sourceStream instanceof this.win["MediaStream"] &&
        typeof this.win["MediaStreamTrackProcessor"] === "function" &&
        typeof this.win["MediaStreamTrackGenerator"] === "function" &&
        typeof this.win["VideoFrame"] === "function";

      const ProcessorCtor = useWinRealm
        ? this.win["MediaStreamTrackProcessor"]
        : (typeof MediaStreamTrackProcessor === "function" ? MediaStreamTrackProcessor : this.win?.["MediaStreamTrackProcessor"]);
      const GeneratorCtor = useWinRealm
        ? this.win["MediaStreamTrackGenerator"]
        : (typeof MediaStreamTrackGenerator === "function" ? MediaStreamTrackGenerator : this.win?.["MediaStreamTrackGenerator"]);
      const FrameCtor = useWinRealm
        ? this.win["VideoFrame"]
        : (typeof VideoFrame === "function" ? VideoFrame : this.win?.["VideoFrame"]);
      const StreamCtor = useWinRealm
        ? this.win["MediaStream"]
        : (typeof MediaStream === "function" ? MediaStream : this.win?.["MediaStream"]);
      const TransformCtor = useWinRealm
        ? (this.win["TransformStream"] ?? TransformStream)
        : (typeof TransformStream === "function" ? TransformStream : this.win?.["TransformStream"]);

      const processor = new ProcessorCtor({ track: videoTrack });
      const generator = new GeneratorCtor({ kind: "video" });
      this.#generator = generator;
      this.#abort = new AbortController();

      const transformer = new TransformCtor({
        transform: (frame, controller) => {
          if (this.disposed) {
            frame.close();
            return;
          }
          try {
            const visible = frame.visibleRect;
            const fw = visible?.width || frame.displayWidth || frame.codedWidth;
            const fh = visible?.height || frame.displayHeight || frame.codedHeight;
            const ox = visible?.x || 0;
            const oy = visible?.y || 0;

            const rect = computePixelCropRect(this.region, fw, fh, ox, oy);
            this.lastSourceSize = { width: fw, height: fh };
            this.lastOutputSize = { width: rect.width, height: rect.height };

            controller.enqueue(
              new FrameCtor(frame, {
                visibleRect: rect,
                timestamp: frame.timestamp,
                duration: frame.duration ?? undefined
              })
            );
          } catch {
            // Mid-stream WebRTC resolution shifts can briefly race rect bounds;
            // pass the uncropped frame through so video never freezes.
            try {
              controller.enqueue(new FrameCtor(frame));
            } catch {}
          } finally {
            // Unclosed VideoFrames stall Chromium's WebRTC decoder pool after ~16 frames.
            frame.close();
          }
        }
      });

      const { signal } = this.#abort;
      processor.readable
        .pipeThrough(transformer, { signal })
        .pipeTo(generator.writable, { signal })
        .catch((err) => {
          if (this.disposed || signal.aborted || videoTrack.readyState === "ended") return;
          logWarn("WebCodecs crop stream failed asynchronously; switching to canvas fallback.", err);
          this.#teardownWebCodecsOnly();
          const fallback = this.startCanvasFallback(audioTracks);
          this.#onStreamReplaced?.(fallback);
        });

      this.outputStream = new StreamCtor([generator, ...audioTracks]);
      CROPPED_STREAMS.add(this.outputStream);
      this.mode = "webcodecs";
      return this.outputStream;
    }

    startCanvasFallback(audioTracks) {
      const hiddenVideo = this.doc.createElement("video");
      hiddenVideo.dataset.dscInternal = "true";
      hiddenVideo.muted = true;
      hiddenVideo.autoplay = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = this.sourceStream;
      hiddenVideo.play()?.catch(() => {});

      const canvas = this.doc.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d", { alpha: false });

      const drawTick = () => {
        if (this.disposed) return;
        const vw = hiddenVideo.videoWidth;
        const vh = hiddenVideo.videoHeight;
        if (vw > 0 && vh > 0 && ctx) {
          const rect = computePixelCropRect(this.region, vw, vh);
          if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
          }
          this.lastSourceSize = { width: vw, height: vh };
          this.lastOutputSize = { width: rect.width, height: rect.height };
          try {
            ctx.drawImage(hiddenVideo, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
          } catch {
            // Frame not yet decoded on `hiddenVideo`.
          }
        }
        this.#rafId = requestAnimFrame(this.win, drawTick);
      };

      drawTick();

      const stream = canvas.captureStream(60);
      for (const audioTrack of audioTracks) {
        stream.addTrack(audioTrack);
      }
      CROPPED_STREAMS.add(stream);

      this.#hiddenVideo = hiddenVideo;
      this.outputStream = stream;
      this.mode = "canvas";
      return this.outputStream;
    }

    #teardownWebCodecsOnly() {
      try {
        this.#abort?.abort();
      } catch {}
      this.#abort = null;

      try {
        this.#generator?.stop?.();
      } catch {}
      this.#generator = null;
    }

    stop() {
      if (this.disposed) return;
      this.disposed = true;

      this.#trackAbort?.abort();
      this.#trackAbort = null;
      this.#teardownWebCodecsOnly();

      if (this.#rafId) {
        cancelAnimFrame(this.win, this.#rafId);
        this.#rafId = 0;
      }

      if (this.#hiddenVideo) {
        this.#hiddenVideo.pause();
        this.#hiddenVideo.srcObject = null;
        this.#hiddenVideo = null;
      }

      // Only stop synthetic canvas video tracks — stopping shared audio tracks
      // would mute the streamer on Discord's original stream too.
      if (this.mode === "canvas") {
        for (const track of this.outputStream?.getVideoTracks?.() ?? []) {
          track.stop?.();
        }
      }

      this.outputStream = null;
    }
  }

  // Owns persisted settings, saved crop presets, and per-streamer crop recall.
  // Sanitizes external storage once on load so the rest of the plugin can trust it.
  class CropStore {
    #dataApi;
    #sessionMemory = new Map();
    #recentHandoff = null; // Captures active crop (or explicit Reset!) across Main <-> Popout transitions

    constructor(dataApi) {
      this.#dataApi = dataApi;
      const raw = this.readRaw();
      const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};

      this.settings = {
        buttonPosition: rawSettings.buttonPosition === "top-left" ? "top-left" : DEFAULT_SETTINGS.buttonPosition,
        rememberPerStreamer: typeof rawSettings.rememberPerStreamer === "boolean"
          ? rawSettings.rememberPerStreamer
          : DEFAULT_SETTINGS.rememberPerStreamer,
        autoCenterUltrawide: !!rawSettings.autoCenterUltrawide,
        defaultSliceAspect: Object.hasOwn(ASPECT_RATIOS, rawSettings.defaultSliceAspect)
          ? rawSettings.defaultSliceAspect
          : DEFAULT_SETTINGS.defaultSliceAspect,
        showResolutionBadge: typeof rawSettings.showResolutionBadge === "boolean"
          ? rawSettings.showResolutionBadge
          : DEFAULT_SETTINGS.showResolutionBadge
      };

      this.presets = Array.isArray(raw.presets)
        ? raw.presets
            .filter((p) => p && typeof p.name === "string" && p.region && typeof p.region === "object")
            .slice(0, MAX_SAVED_PRESETS)
            .map((p) => ({ name: p.name.slice(0, 20), region: normalizeRegion(p.region) }))
        : [];

      this.rememberedCrops = Array.isArray(raw.rememberedCrops)
        ? raw.rememberedCrops
            .filter((item) => item && typeof item.key === "string" && item.region && typeof item.region === "object")
            .slice(0, MAX_REMEMBERED_STREAMS)
            .map((item) => ({
              key: item.key,
              region: isFullRegion(item.region) ? { ...FULL_REGION } : normalizeRegion(item.region),
              preset: typeof item.preset === "string" ? item.preset : "custom",
              isReset: !!item.isReset || isFullRegion(item.region),
              updatedAt: Number(item.updatedAt) || 0
            }))
        : [];
    }

    readRaw() {
      try {
        const loaded = this.#dataApi?.load("config");
        return loaded && typeof loaded === "object" ? loaded : {};
      } catch (err) {
        logWarn("Failed to read saved plugin config; using defaults.", err);
        return {};
      }
    }

    save() {
      try {
        this.#dataApi?.save("config", {
          settings: this.settings,
          presets: this.presets,
          rememberedCrops: this.rememberedCrops
        });
      } catch (err) {
        logWarn("Failed to save plugin config.", err);
      }
    }

    updateSetting(id, value) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, id)) return;
      this.settings[id] = value;
      this.save();
    }

    savePreset(name, region) {
      const cleanName = String(name ?? "").trim().slice(0, 20);
      if (!cleanName) return this.presets;

      const entry = { name: cleanName, region: normalizeRegion(region) };
      const idx = this.presets.findIndex((p) => p.name.toLowerCase() === cleanName.toLowerCase());
      if (idx >= 0) {
        this.presets[idx] = entry;
      } else {
        if (this.presets.length >= MAX_SAVED_PRESETS) this.presets.shift();
        this.presets.push(entry);
      }
      this.save();
      return this.presets;
    }

    deletePreset(index) {
      if (index < 0 || index >= this.presets.length) return this.presets;
      this.presets.splice(index, 1);
      this.save();
      return this.presets;
    }

    recordHandoff(identities, region, preset = "custom", sourceIsPopout = false) {
      const isFull = isFullRegion(region);
      this.#recentHandoff = {
        region: isFull ? { ...FULL_REGION } : normalizeRegion(region),
        preset: isFull ? "full" : preset,
        isReset: isFull,
        sourceIsPopout: !!sourceIsPopout,
        width: identities?.width || 0,
        height: identities?.height || 0,
        streamer: identities?.primaryStreamer || "",
        sessionKeys: [...(identities?.sessionKeys ?? [])],
        updatedAt: Date.now()
      };
    }

    rememberStream(identities, region, preset = "custom", sourceIsPopout = false) {
      if (!identities) return;

      const isFull = isFullRegion(region);
      const now = Date.now();
      const record = {
        region: isFull ? { ...FULL_REGION } : normalizeRegion(region),
        preset: isFull ? "full" : preset,
        isReset: isFull,
        updatedAt: now
      };

      // Always record cross-window handoff even if `rememberPerStreamer` is disabled
      this.recordHandoff(identities, region, record.preset, sourceIsPopout);

      if (!this.settings.rememberPerStreamer) return;

      // Store explicit `isReset: true` tombstones in sessionMemory too so resetting a crop
      // overrides any older resolution/aspect fallback key AND suppresses `autoCenterUltrawide`!
      for (const sessionKey of identities.sessionKeys) {
        this.#sessionMemory.set(sessionKey, record);
      }

      let dirty = false;
      const streamerKeys = identities.streamerKeys ?? [];
      const fallbackKeys = identities.fallbackKeys ?? [];

      // When clearing/resetting a crop, purge EVERY resolution variant for this streamer
      // (`streamer:name|*`) AND any matching legacy ultrawide resolution/aspect keys!
      if (isFull) {
        const streamerNames = new Set();
        for (const key of streamerKeys) {
          if (key.startsWith("streamer:")) {
            const rawName = key.slice("streamer:".length).split("|")[0];
            if (rawName) streamerNames.add(rawName);
          }
        }
        const aspectRatio =
          identities.width > 0 && identities.height > 0
            ? identities.width / identities.height
            : 0;

        for (let i = this.rememberedCrops.length - 1; i >= 0; i--) {
          const itemKey = this.rememberedCrops[i].key;
          let shouldPurge = identities.persistentKeys.includes(itemKey);

          if (!shouldPurge && streamerNames.size > 0 && itemKey.startsWith("streamer:")) {
            const itemStreamer = itemKey.slice("streamer:".length).split("|")[0];
            if (streamerNames.has(itemStreamer)) shouldPurge = true;
          }

          // Only purge shared fallback keys if they hold an active crop (or if we have no
          // streamer name), so resetting Streamer B cleans up legacy `ultrawide-res:*`
          // without writing a global fallback tombstone that clobbers Streamer A!
          if (!shouldPurge && itemKey.startsWith("ultrawide-res:")) {
            const dimsPart = itemKey.slice("ultrawide-res:".length);
            const [uw, uh] = dimsPart.split("x").map(Number);
            if (aspectRatio <= 0 || (uw > 0 && uh > 0 && Math.abs(uw / uh - aspectRatio) < 0.25)) {
              shouldPurge = true;
            }
          }

          if (!shouldPurge && itemKey.startsWith("ultrawide-aspect:")) {
            const savedAspect = Number(itemKey.slice("ultrawide-aspect:".length));
            if (aspectRatio <= 0 || (savedAspect > 0 && Math.abs(savedAspect - aspectRatio) < 0.25)) {
              shouldPurge = true;
            }
          }

          if (shouldPurge) {
            this.rememberedCrops.splice(i, 1);
            dirty = true;
          }
        }
      }

      // Scope writes by specificity: when `streamerKeys` exist, persist under `streamerKeys`
      // ONLY (never polluting shared `ultrawide-*` keys across different streamers!).
      // Fall back to `fallbackKeys` only when no streamer name badge is present in the DOM.
      const keysToWrite = streamerKeys.length > 0 ? streamerKeys : fallbackKeys;
      for (const key of keysToWrite) {
        const idx = this.rememberedCrops.findIndex((item) => item.key === key);
        if (idx >= 0) this.rememberedCrops.splice(idx, 1);
        this.rememberedCrops.push({ key, ...record });
        while (this.rememberedCrops.length > MAX_REMEMBERED_STREAMS) {
          this.rememberedCrops.shift();
        }
        dirty = true;
      }

      if (dirty) this.save();
    }

    recallStream(identities, { allowRecentHandoff = false, isPopout = false } = {}) {
      if (!identities) return null;

      if (this.settings.rememberPerStreamer) {
        for (const sessionKey of identities.sessionKeys) {
          const hit = this.#sessionMemory.get(sessionKey);
          if (hit) return hit;
        }

        // Tier 1: Streamer-specific keys ALWAYS take precedence over generic resolution fallbacks!
        const streamerSet = new Set(identities.streamerKeys ?? []);
        if (streamerSet.size > 0) {
          for (let i = this.rememberedCrops.length - 1; i >= 0; i--) {
            const item = this.rememberedCrops[i];
            if (streamerSet.has(item.key)) return item;
          }
        }

        // Tier 2: Generic ultrawide resolution/aspect fallback (used only when no streamer entry matched)
        const fallbackSet = new Set(identities.fallbackKeys ?? []);
        if (fallbackSet.size > 0) {
          for (let i = this.rememberedCrops.length - 1; i >= 0; i--) {
            const item = this.rememberedCrops[i];
            if (fallbackSet.has(item.key)) return item;
          }
        }
      }

      // Tier 3: Cross-window transition handoff (Main <-> Popout ONLY, `isPopout !== sourceIsPopout`):
      // Never fires across two different streams in the same window!
      if (allowRecentHandoff && this.#recentHandoff && Boolean(isPopout) !== this.#recentHandoff.sourceIsPopout) {
        const ageMs = Date.now() - this.#recentHandoff.updatedAt;
        if (ageMs <= 8000) {
          const handoffKeys = new Set(this.#recentHandoff.sessionKeys);
          const sameSession = identities.sessionKeys.some((k) => handoffKeys.has(k));
          const sameStreamer =
            this.#recentHandoff.streamer &&
            identities.primaryStreamer &&
            this.#recentHandoff.streamer === identities.primaryStreamer;
          const conflictingStreamer =
            this.#recentHandoff.streamer &&
            identities.primaryStreamer &&
            this.#recentHandoff.streamer !== identities.primaryStreamer;
          const sameDims =
            !this.#recentHandoff.width ||
            !identities.width ||
            (this.#recentHandoff.width === identities.width && this.#recentHandoff.height === identities.height);

          if (!conflictingStreamer && (sameSession || sameStreamer || sameDims)) {
            return this.#recentHandoff;
          }
        }
      }

      return null;
    }

    clearSession() {
      this.#sessionMemory.clear();
      this.#recentHandoff = null;
    }
  }

  class StreamCropper {
    #listeners = null;
    #trackedDocs = new Map();
    #popoutStore = null;
    #scanTimer = null;
    #rescanInterval = null;

    constructor(meta = {}) {
      this.meta = meta;
      const pluginName = meta.name || PLUGIN_NAME;
      this.api = typeof BdApi === "function"
        ? new BdApi(pluginName)
        : {
            DOM: {
              addStyle: (css) => BdApi.DOM.addStyle(STYLE_ID, css),
              removeStyle: () => BdApi.DOM.removeStyle(STYLE_ID),
              onRemoved: (node, cb) => BdApi.DOM.onRemoved?.(node, cb)
            },
            Data: {
              load: (key) => BdApi.Data.load(pluginName, key),
              save: (key, val) => BdApi.Data.save(pluginName, key, val)
            },
            UI: BdApi.UI,
            Webpack: BdApi.Webpack
          };

      this.store = new CropStore(this.api.Data);
      this.controllers = new Map();
      this.running = false;
    }

    get settings() {
      return this.store.settings;
    }

    get savedPresets() {
      return this.store.presets;
    }

    start() {
      if (this.running) return;
      this.running = true;

      try {
        const webpackApi = this.api.Webpack ?? (typeof BdApi !== "undefined" ? BdApi.Webpack : null);
        this.#popoutStore =
          webpackApi?.getStore?.("PopoutWindowStore") ??
          webpackApi?.getByKeys?.("getWindow", "getWindowKeys") ??
          null;
      } catch (err) {
        logWarn("Failed to resolve PopoutWindowStore; popout window discovery restricted to iframes.", err);
        this.#popoutStore = null;
      }

      this.api.DOM.addStyle(STYLES);

      this.#listeners = new AbortController();
      this.bindDocumentEvents(document, window, this.#listeners.signal);
      this.scan();

      // Discord assigns `video.srcObject` asynchronously after mounting `<video>`,
      // which does not emit a DOM mutation record.
      this.#rescanInterval = setInterval(() => {
        if (this.running) this.scan();
      }, 1500);
    }

    bindDocumentEvents(doc, win, signal) {
      const onOutsidePointer = (event) => {
        for (const controller of this.controllers.values()) {
          if (controller.doc === doc) {
            controller.handleOutsidePointer(event);
          }
        }
      };

      doc.addEventListener("pointerdown", onOutsidePointer, { capture: true, signal });
      doc.addEventListener("mousedown", onOutsidePointer, { capture: true, signal });

      const onEscapeKeyDown = (event) => {
        if (event.key !== "Escape") return;
        for (const controller of this.controllers.values()) {
          if (controller.doc !== doc) continue;
          if (controller.isDrawing) {
            event.stopPropagation();
            event.preventDefault();
            controller.closeDrawModal();
          } else if (controller.isOpen) {
            controller.closeHud();
          }
        }
      };

      // Listen on `window` capture first (fires before `document` / React targets so
      // Escape cancels drawing without accidentally exiting Discord fullscreen), plus
      // `doc` capture if events are dispatched directly onto the document.
      if (win?.addEventListener) {
        win.addEventListener("keydown", onEscapeKeyDown, { capture: true, signal });
      }
      doc.addEventListener("keydown", onEscapeKeyDown, { capture: true, signal });
    }

    collectDocuments() {
      const docs = [document];
      const seen = new Set(docs);

      const addWin = (win) => {
        try {
          if (!win || win.closed || !win.document) return;
          const doc = win.document;
          if (!seen.has(doc)) {
            seen.add(doc);
            docs.push(doc);
          }
        } catch {
          // Cross-origin frame access denied.
        }
      };

      if (this.#popoutStore && typeof this.#popoutStore.getWindowKeys === "function" && typeof this.#popoutStore.getWindow === "function") {
        try {
          const keys = this.#popoutStore.getWindowKeys() ?? [];
          for (const key of keys) {
            addWin(this.#popoutStore.getWindow(key));
          }
        } catch (err) {
          logWarn("Failed reading open popout windows from PopoutWindowStore.", err);
        }
      }

      for (const iframe of document.querySelectorAll("iframe")) {
        try {
          if (iframe.contentWindow) {
            addWin(iframe.contentWindow);
          } else if (iframe.contentDocument && !seen.has(iframe.contentDocument)) {
            seen.add(iframe.contentDocument);
            docs.push(iframe.contentDocument);
          }
        } catch {
          // Cross-origin iframe; ignore safely.
        }
      }

      return docs;
    }

    ensureSecondaryDocumentStyles(doc) {
      if (!doc || doc === document) return null;
      let styleEl = doc.getElementById?.(STYLE_ID) ?? null;
      if (styleEl) return styleEl;

      const styleTarget = doc.head || doc.documentElement;
      if (!styleTarget) return null;

      styleEl = doc.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.textContent = STYLES;
      styleTarget.appendChild(styleEl);
      return styleEl;
    }

    ensureSecondaryDocumentTracked(doc) {
      if (!doc || doc === document) return;
      const win = doc.defaultView;
      if (win?.closed) return;

      const existing = this.#trackedDocs.get(doc);
      if (existing) {
        // Discord's WindowPortal clears or clones `<head>` stylesheets asynchronously
        // after `window.open`; re-verify our `<style>` is still in `doc` every scan!
        if (!existing.styleEl?.isConnected || !doc.getElementById?.(STYLE_ID)) {
          existing.styleEl = this.ensureSecondaryDocumentStyles(doc);
        }
        return;
      }

      const abort = new AbortController();
      const { signal } = abort;
      const styleEl = this.ensureSecondaryDocumentStyles(doc);

      this.bindDocumentEvents(doc, win, signal);
      win?.addEventListener?.("unload", () => this.cleanupDocument(doc), { once: true, signal });

      let observer = null;
      const ObserverCtor = win?.MutationObserver ?? (typeof MutationObserver === "function" ? MutationObserver : null);
      const observeTarget = doc.documentElement || doc.body;
      if (ObserverCtor && observeTarget) {
        observer = new ObserverCtor((mutations) => {
          if (!this.running) return;
          // Immediately re-inject `<style>` if Discord's popout portal wiped `<head>`!
          if (!doc.getElementById?.(STYLE_ID)) {
            const tracked = this.#trackedDocs.get(doc);
            if (tracked) tracked.styleEl = this.ensureSecondaryDocumentStyles(doc);
          }
          if (!mutations?.length || mutations.some((m) => m?.addedNodes?.length || m?.removedNodes?.length)) {
            this.scheduleScan();
          }
        });
        observer.observe(observeTarget, { childList: true, subtree: true });
      }

      this.#trackedDocs.set(doc, { abort, styleEl, observer });
    }

    cleanupDocument(doc) {
      const tracked = this.#trackedDocs.get(doc);
      if (tracked) {
        this.#trackedDocs.delete(doc);
        try {
          tracked.abort.abort();
        } catch {}
        try {
          tracked.observer?.disconnect?.();
        } catch {}
        try {
          tracked.styleEl?.remove?.();
        } catch {}
      }

      for (const [video, controller] of this.controllers) {
        if (controller.doc === doc || video.ownerDocument === doc) {
          controller.destroy();
          this.controllers.delete(video);
        }
      }
    }

    observer(mutation) {
      if (!this.running) return;
      if (mutation?.addedNodes?.length || mutation?.removedNodes?.length) {
        this.scheduleScan();
      }
      // Also catch videos moved via React portals into a Popout Window (where the
      // mutation fires inside `popoutWindow.document`, not the main `document`!):
      for (const [video, controller] of this.controllers) {
        if (video.ownerDocument !== controller.doc) {
          this.scheduleScan();
          break;
        }
      }
    }

    onSwitch() {
      if (this.running) this.scheduleScan();
    }

    stop() {
      this.running = false;

      clearTimeout(this.#scanTimer);
      this.#scanTimer = null;

      clearInterval(this.#rescanInterval);
      this.#rescanInterval = null;

      this.#listeners?.abort();
      this.#listeners = null;

      for (const doc of [...this.#trackedDocs.keys()]) {
        this.cleanupDocument(doc);
      }
      this.#trackedDocs.clear();
      this.#popoutStore = null;

      for (const controller of this.controllers.values()) {
        controller.destroy();
      }
      this.controllers.clear();
      this.store.clearSession();

      this.api.DOM.removeStyle();
    }

    getSettingsPanel() {
      return this.api.UI.buildSettingsPanel({
        settings: [
          {
            type: "dropdown",
            id: "buttonPosition",
            name: "Overlay Button Position",
            note: "Which corner of the stream player shows the Crop button on hover.",
            value: this.settings.buttonPosition,
            options: [
              { label: "Top Right", value: "top-right" },
              { label: "Top Left", value: "top-left" }
            ]
          },
          {
            type: "dropdown",
            id: "defaultSliceAspect",
            name: "Left / Center / Right Target Aspect Ratio",
            note: "Aspect ratio carved out when clicking Left, Center, or Right on an ultrawide stream.",
            value: this.settings.defaultSliceAspect,
            options: [
              { label: "16:9 Standard Monitor", value: "16:9" },
              { label: "21:9 Ultrawide", value: "21:9" },
              { label: "4:3 Classic", value: "4:3" }
            ]
          },
          {
            type: "switch",
            id: "rememberPerStreamer",
            name: "Remember Crop Per Streamer",
            note: "Restores your last crop automatically if you click off someone's stream and click back.",
            value: this.settings.rememberPerStreamer
          },
          {
            type: "switch",
            id: "autoCenterUltrawide",
            name: "Auto-Center Ultrawide Streams (21:9 / 32:9)",
            note: "Automatically start in Center crop whenever an ultrawide screen share opens.",
            value: this.settings.autoCenterUltrawide
          },
          {
            type: "switch",
            id: "showResolutionBadge",
            name: "Show Cropped Resolution on Pill",
            note: "Shows the active output dimensions (e.g. 2560×1440) next to the Crop button.",
            value: this.settings.showResolutionBadge
          }
        ],
        onChange: (_category, id, value) => {
          this.store.updateSetting(id, value);
          for (const controller of this.controllers.values()) {
            if (id === "autoCenterUltrawide" && value === true) {
              controller.handleStreamMetadata();
            } else {
              controller.syncUI();
            }
          }
        }
      });
    }

    showToast(message, type = "info") {
      this.api.UI?.showToast?.(message, { type });
    }

    attachTooltip(node, text) {
      if (!node) return null;
      if (node.ownerDocument && node.ownerDocument !== document) {
        node.title = text;
        return null;
      }
      if (this.api.UI?.createTooltip) {
        try {
          return this.api.UI.createTooltip(node, text, { side: "bottom", style: "primary" });
        } catch (err) {
          logWarn("Failed to attach BetterDiscord tooltip; falling back to title attribute.", err);
        }
      }
      node.title = text;
      return null;
    }

    rememberStreamCrop(identities, region, preset, sourceController = null) {
      const sourceIsPopout = Boolean(sourceController?.doc && sourceController.doc !== document);
      this.store.rememberStream(identities, region, preset, sourceIsPopout);
      // Synchronize any other mounted controller showing the same stream (e.g. Main + Popout)
      const sessionSet = new Set(identities?.sessionKeys ?? []);
      const primary = identities?.primaryStreamer;
      for (const other of this.controllers.values()) {
        if (!other || other === sourceController) continue;
        const otherId = other.getStreamIdentities();
        const matchesSession = otherId.sessionKeys.some((k) => sessionSet.has(k));
        const matchesStreamer = primary && otherId.primaryStreamer && primary === otherId.primaryStreamer;
        if (matchesSession || matchesStreamer) {
          if (isFullRegion(region)) {
            other.reset(false);
          } else {
            other.activePreset = preset || "custom";
            other.setRegion(region, false);
          }
        }
      }
    }

    recallStreamCrop(identities, options) {
      return this.store.recallStream(identities, options);
    }

    recordStreamHandoff(identities, region, preset, sourceIsPopout = false) {
      this.store.recordHandoff(identities, region, preset, sourceIsPopout);
    }

    savePreset(name, region) {
      const presets = this.store.savePreset(name, region);
      for (const controller of this.controllers.values()) {
        controller.renderSavedPresets();
      }
      return presets;
    }

    deletePreset(index) {
      const presets = this.store.deletePreset(index);
      for (const controller of this.controllers.values()) {
        controller.renderSavedPresets();
      }
      return presets;
    }

    scheduleScan() {
      if (!this.running || this.#scanTimer) return;
      this.#scanTimer = setTimeout(() => {
        this.#scanTimer = null;
        if (this.running) this.scan();
      }, 120);
    }

    getCandidateIdentities(video) {
      const doc = video?.ownerDocument || document;
      const stream = video?.srcObject ?? null;
      const [vTrack] = stream?.getVideoTracks?.() ?? [];
      const settings = vTrack?.getSettings?.();
      const width = settings?.width || video?.videoWidth || 0;
      const height = settings?.height || video?.videoHeight || 0;
      const host = resolvePlayerHostForVideo(video, doc);
      const streamers = extractStreamerLabels(host, doc !== document ? doc : null);
      return {
        identities: buildStreamIdentities(stream, { width, height }, streamers),
        width,
        height
      };
    }

    isRetainedControllerValid(video, controller) {
      if (!video || video.nodeName !== "VIDEO" || !video.isConnected) return false;
      if (video.dataset.dscInternal === "true") return false;
      const doc = video.ownerDocument || document;
      const win = doc.defaultView || window;
      if (doc !== document && win?.closed) return false;
      if (!isMediaStream(video.srcObject, win)) return false;

      // Never drop an active crop — even if layout dimensions hit 0 during OS PiP or route transitions.
      if (!isFullRegion(controller.region)) return true;

      const rect = video.getBoundingClientRect();
      const width = video.clientWidth || rect.width;
      const height = video.clientHeight || rect.height;

      if (width > MIN_STAGE_VIDEO_WIDTH && height > MIN_STAGE_VIDEO_HEIGHT) return true;

      if (width >= MIN_MINIPLAYER_WIDTH && height >= MIN_MINIPLAYER_HEIGHT && isStandaloneMiniPlayerVideo(video, doc)) {
        // Keep an already-mounted standalone mini-player controller alive even after user clicks Reset
        // so the compact Crop pill doesn't disappear right under their cursor!
        return true;
      }

      return false;
    }

    isEligibleStreamVideo(video) {
      if (!video || video.nodeName !== "VIDEO" || !video.isConnected) return false;
      if (video.dataset.dscInternal === "true") return false;
      const doc = video.ownerDocument || document;
      const win = doc.defaultView || window;
      if (doc !== document && win?.closed) return false;
      if (!isMediaStream(video.srcObject, win)) return false;

      const rect = video.getBoundingClientRect();
      const width = video.clientWidth || rect.width;
      const height = video.clientHeight || rect.height;

      if (width > MIN_STAGE_VIDEO_WIDTH && height > MIN_STAGE_VIDEO_HEIGHT) return true;

      if (width >= MIN_MINIPLAYER_WIDTH && height >= MIN_MINIPLAYER_HEIGHT && isStandaloneMiniPlayerVideo(video, doc)) {
        const { identities, width: srcW, height: srcH } = this.getCandidateIdentities(video);
        const recalled = this.recallStreamCrop(identities, { isPopout: doc !== document });
        if (recalled?.isReset) return false;
        if (recalled && !isFullRegion(recalled.region)) return true;

        if (this.settings.autoCenterUltrawide) {
          return srcW === 0 || srcW / Math.max(1, srcH) > 2.15;
        }
      }

      return false;
    }

    scan() {
      if (!this.running) return;

      const activeDocs = this.collectDocuments();
      // Also discover any popout `ownerDocument` that Discord adopted an existing `<video>` into
      // even if `PopoutWindowStore` has not registered or matched by key yet!
      for (const video of this.controllers.keys()) {
        const vDoc = video.ownerDocument;
        if (vDoc && vDoc !== document && !vDoc.defaultView?.closed && !activeDocs.includes(vDoc)) {
          activeDocs.push(vDoc);
        }
      }
      const activeDocSet = new Set(activeDocs);

      for (const doc of [...this.#trackedDocs.keys()]) {
        if (!activeDocSet.has(doc) || doc.defaultView?.closed) {
          this.cleanupDocument(doc);
        }
      }

      for (const doc of activeDocs) {
        if (doc !== document) {
          this.ensureSecondaryDocumentTracked(doc);
        }
      }

      for (const [video, controller] of this.controllers) {
        // Critical: if Discord moved `<video>` across documents (Main Window <-> Popout Window),
        // tear down the old document's controller cleanly so a fresh controller mounts in `video.ownerDocument`!
        const docChanged = video.ownerDocument !== controller.doc;
        if (docChanged || !activeDocSet.has(controller.doc) || !video.isConnected || !this.isRetainedControllerValid(video, controller)) {
          controller.destroy();
          this.controllers.delete(video);
        } else {
          controller.ensureMounted();
        }
      }

      for (const doc of activeDocs) {
        for (const video of doc.querySelectorAll("video")) {
          if (!this.controllers.has(video) && this.isEligibleStreamVideo(video)) {
            const controller = new VideoSourceController(video, this);
            if (controller.mount()) {
              this.controllers.set(video, controller);
            } else {
              controller.destroy();
            }
          }
        }
      }
    }
  }

  // Stop clicks, double-clicks, drags, and wheel events on our UI from bubbling
  // into Discord's player (where double-click toggles fullscreen).
  function shieldPlayerEvents(el, signal) {
    const events = ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu", "wheel"];
    for (const type of events) {
      el.addEventListener(
        type,
        (e) => {
          e.stopPropagation();
          if (type === "dblclick") e.preventDefault();
        },
        { passive: type !== "wheel", signal }
      );
    }
  }

  // Renders the floating Crop pill, live source minimap HUD, and full-frame custom
  // draw modal. Communicates user intent back to `VideoSourceController` via methods.
  class StreamCropOverlay {
    #controller;
    #listeners = new AbortController();
    #presetRenderAbort = null;
    #modalAbort = null;
    #minimapRaf = 0;
    #lastMinimapTs = 0;
    #drawModalRaf = 0;
    #tooltips = [];
    #presetBtns = new Map();

    constructor(controller) {
      this.#controller = controller;
      this.doc = controller.doc;
      this.win = controller.win;
      this.isOpen = false;
      this.isDrawing = false;

      this.rootEl = null;
      this.triggerBtn = null;
      this.triggerResSpan = null;
      this.hudEl = null;
      this.metaSpan = null;
      this.minimapEl = null;
      this.minimapCanvas = null;
      this.minimapBox = null;
      this.savedRowEl = null;
      this.drawModalEl = null;
    }

    build() {
      const { signal } = this.#listeners;
      const manager = this.#controller.manager;
      const doc = this.doc;

      const root = doc.createElement("div");
      root.className = "dsc-root";

      const trigger = doc.createElement("button");
      trigger.type = "button";
      trigger.className = "dsc-trigger";
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      const tip = manager.attachTooltip(trigger, "Crop stream source");
      if (tip) this.#tooltips.push(tip);
      trigger.innerHTML = `${ICONS.crop}<span>Crop</span>`;

      const resSpan = doc.createElement("span");
      resSpan.className = "dsc-trigger-res";
      const dotSpan = doc.createElement("span");
      dotSpan.className = "dsc-dot";
      trigger.append(resSpan, dotSpan);

      shieldPlayerEvents(trigger, signal);
      trigger.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          this.toggleHud();
        },
        { signal }
      );

      const hud = doc.createElement("div");
      hud.className = "dsc-hud";
      hud.setAttribute("role", "dialog");
      hud.setAttribute("aria-label", "Stream Source Crop");
      shieldPlayerEvents(hud, signal);

      const header = doc.createElement("div");
      header.className = "dsc-header";

      const titleWrap = doc.createElement("div");
      titleWrap.className = "dsc-title-wrap";

      const title = doc.createElement("span");
      title.className = "dsc-title";
      title.textContent = "Source Crop";

      const meta = doc.createElement("span");
      meta.className = "dsc-meta";
      meta.textContent = "Full Stream";
      titleWrap.append(title, meta);

      const headerBtns = doc.createElement("div");
      headerBtns.className = "dsc-header-btns";

      const resetBtn = doc.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "dsc-icon-btn dsc-reset-btn";
      resetBtn.title = "Restore uncropped stream";
      resetBtn.setAttribute("aria-label", "Reset crop");
      resetBtn.innerHTML = `${ICONS.reset}<span>Reset</span>`;
      resetBtn.addEventListener("click", () => this.#controller.reset(), { signal });

      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "dsc-icon-btn";
      closeBtn.title = "Close panel";
      closeBtn.setAttribute("aria-label", "Close crop panel");
      closeBtn.innerHTML = ICONS.close;
      closeBtn.addEventListener("click", () => this.closeHud(), { signal });

      headerBtns.append(resetBtn, closeBtn);
      header.append(titleWrap, headerBtns);
      hud.appendChild(header);

      const chips = doc.createElement("div");
      chips.className = "dsc-chips";
      const presets = [
        { id: "full", label: "Full", title: "Original uncropped stream" },
        { id: "left", label: "Left", title: "Left monitor / slice" },
        { id: "center", label: "Center", title: "Center monitor / slice" },
        { id: "right", label: "Right", title: "Right monitor / slice" },
        { id: "21:9", label: "21:9", title: "Center 21:9 crop" }
      ];
      for (const preset of presets) {
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "dsc-chip";
        btn.dataset.preset = preset.id;
        btn.textContent = preset.label;
        btn.title = preset.title;
        btn.setAttribute("aria-pressed", "false");
        btn.addEventListener("click", () => this.#controller.applyPreset(preset.id), { signal });
        this.#presetBtns.set(preset.id, btn);
        chips.appendChild(btn);
      }
      hud.appendChild(chips);

      const minimap = doc.createElement("div");
      minimap.className = "dsc-minimap";
      minimap.tabIndex = 0;
      minimap.setAttribute("role", "application");
      minimap.setAttribute("aria-label", "Crop region selector — use arrow keys to nudge, +/- to zoom, or drag with mouse");
      minimap.title = "Drag box to pan, drag handles to resize, arrow keys to nudge, or double-click to reset";

      const mmCanvas = doc.createElement("canvas");
      mmCanvas.className = "dsc-minimap-canvas";
      mmCanvas.width = 320;
      mmCanvas.height = 180;

      const box = doc.createElement("div");
      box.className = "dsc-minimap-box";
      for (const dir of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
        const handle = doc.createElement("div");
        handle.className = `dsc-handle dsc-handle-${dir}`;
        handle.dataset.handle = dir;
        box.appendChild(handle);
      }

      minimap.append(mmCanvas, box);
      this.attachMinimapHandlers(minimap, box, signal);
      hud.appendChild(minimap);

      const footer = doc.createElement("div");
      footer.className = "dsc-footer";

      const drawBtn = doc.createElement("button");
      drawBtn.type = "button";
      drawBtn.className = "dsc-icon-btn dsc-draw-full-btn";
      drawBtn.title = "Draw a custom crop box on the full uncropped frame";
      drawBtn.innerHTML = `${ICONS.draw}<span>Draw Custom Region</span>`;
      drawBtn.addEventListener("click", () => this.openDrawModal(), { signal });

      const saveBtn = doc.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "dsc-icon-btn dsc-save-btn";
      saveBtn.title = "Save current crop preset";
      saveBtn.innerHTML = `${ICONS.bookmark}<span>Save</span>`;
      saveBtn.addEventListener(
        "click",
        () => {
          if (isFullRegion(this.#controller.region)) {
            manager.showToast("Select a crop area before saving a preset", "warning");
            return;
          }
          const count = manager.savedPresets.length;
          const active = this.#controller.activePreset;
          const label = active !== "custom" && active !== "full"
            ? active.toUpperCase()
            : `Crop ${count + 1}`;
          manager.savePreset(label, this.#controller.region);
          manager.showToast(`Saved "${label}"`, "success");
        },
        { signal }
      );

      footer.append(drawBtn, saveBtn);
      hud.appendChild(footer);

      const savedRow = doc.createElement("div");
      savedRow.className = "dsc-saved-row";
      hud.appendChild(savedRow);

      // Embed a local `<style>` inside `root` for secondary popout documents so
      // Discord's WindowPortal stylesheet sync can NEVER wipe our CSS rules!
      if (doc !== document) {
        const localStyle = doc.createElement("style");
        localStyle.textContent = STYLES;
        root.appendChild(localStyle);
      }

      root.append(trigger, hud);

      this.rootEl = root;
      this.triggerBtn = trigger;
      this.triggerResSpan = resSpan;
      this.hudEl = hud;
      this.metaSpan = meta;
      this.minimapEl = minimap;
      this.minimapCanvas = mmCanvas;
      this.minimapBox = box;
      this.savedRowEl = savedRow;

      this.renderSavedPresets();
      return root;
    }

    zoomAroundCenter(factor) {
      const ctrl = this.#controller;
      const cx = ctrl.region.x + ctrl.region.w / 2;
      const cy = ctrl.region.y + ctrl.region.h / 2;
      let baseW = ctrl.region.w;
      let baseH = ctrl.region.h;

      if (isFullRegion(ctrl.region) && factor < 1) {
        const dims = ctrl.getOriginalDimensions();
        const aspect = dims.width / Math.max(1, dims.height);
        const target = ASPECT_RATIOS[ctrl.manager.settings.defaultSliceAspect] ?? 16 / 9;
        baseW = aspect > target ? clamp(target / aspect, 0.25, 0.9) : 0.85;
        baseH = aspect > target ? 0.9 : 0.85;
      }

      const nw = clamp(baseW * factor, MIN_CROP_FRACTION, 1);
      const nh = clamp(baseH * factor, MIN_CROP_FRACTION, 1);
      if (nw >= 0.995 && nh >= 0.995) {
        ctrl.reset();
        return;
      }
      ctrl.activePreset = "custom";
      ctrl.setRegion({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
    }

    attachMinimapHandlers(minimap, box, signal) {
      const ctrl = this.#controller;

      minimap.addEventListener(
        "dblclick",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          ctrl.reset();
        },
        { signal }
      );

      minimap.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.zoomAroundCenter(e.deltaY < 0 ? 0.9 : 1.1);
        },
        { passive: false, signal }
      );

      minimap.addEventListener(
        "keydown",
        (e) => {
          const step = e.shiftKey ? 0.08 : 0.025;
          const reg = ctrl.region;
          if (e.key === "+" || e.key === "=") {
            e.preventDefault();
            e.stopPropagation();
            this.zoomAroundCenter(0.9);
          } else if (e.key === "-" || e.key === "_") {
            e.preventDefault();
            e.stopPropagation();
            this.zoomAroundCenter(1.1);
          } else if (e.key === "0" || e.key === "Backspace") {
            e.preventDefault();
            e.stopPropagation();
            ctrl.reset();
          } else if (!isFullRegion(reg) && e.key.startsWith("Arrow")) {
            e.preventDefault();
            e.stopPropagation();
            const dx = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
            const dy = e.key === "ArrowDown" ? step : e.key === "ArrowUp" ? -step : 0;
            ctrl.activePreset = "custom";
            ctrl.setRegion({
              x: clamp(reg.x + dx, 0, 1 - reg.w),
              y: clamp(reg.y + dy, 0, 1 - reg.h),
              w: reg.w,
              h: reg.h
            });
          }
        },
        { signal }
      );

      minimap.addEventListener(
        "mousedown",
        (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();

          const rect = minimap.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;

          const handleDir = e.target?.dataset?.handle ?? null;
          const insideBox = box.contains(e.target) && !handleDir;
          const startX = e.clientX;
          const startY = e.clientY;
          const startReg = { ...ctrl.region };

          const mode = handleDir
            ? `resize-${handleDir}`
            : insideBox && !isFullRegion(ctrl.region)
              ? "move"
              : "create";

          const originX = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          const originY = clamp((e.clientY - rect.top) / rect.height, 0, 1);
          const dragAbort = new AbortController();
          let didDrag = false;

          const onMove = (me) => {
            me.preventDefault();
            me.stopPropagation();

            const dx = (me.clientX - startX) / rect.width;
            const dy = (me.clientY - startY) / rect.height;

            if (mode === "move") {
              didDrag = true;
              ctrl.activePreset = "custom";
              ctrl.setRegion(
                {
                  x: clamp(startReg.x + dx, 0, 1 - startReg.w),
                  y: clamp(startReg.y + dy, 0, 1 - startReg.h),
                  w: startReg.w,
                  h: startReg.h
                },
                false
              );
              return;
            }

            if (mode === "create") {
              const curX = clamp((me.clientX - rect.left) / rect.width, 0, 1);
              const curY = clamp((me.clientY - rect.top) / rect.height, 0, 1);
              const w = Math.abs(curX - originX);
              const h = Math.abs(curY - originY);
              if (w < 0.03 && h < 0.03) return;
              didDrag = true;
              ctrl.activePreset = "custom";
              ctrl.setRegion(
                {
                  x: Math.min(originX, curX),
                  y: Math.min(originY, curY),
                  w: Math.max(MIN_CROP_FRACTION, w),
                  h: Math.max(MIN_CROP_FRACTION, h)
                },
                false
              );
              return;
            }

            const dir = mode.slice("resize-".length);
            let left = startReg.x;
            let right = startReg.x + startReg.w;
            let top = startReg.y;
            let bottom = startReg.y + startReg.h;

            if (dir.includes("w")) left = clamp(left + dx, 0, right - MIN_CROP_FRACTION);
            if (dir.includes("e")) right = clamp(right + dx, left + MIN_CROP_FRACTION, 1);
            if (dir.includes("n")) top = clamp(top + dy, 0, bottom - MIN_CROP_FRACTION);
            if (dir.includes("s")) bottom = clamp(bottom + dy, top + MIN_CROP_FRACTION, 1);

            didDrag = true;
            ctrl.activePreset = "custom";
            ctrl.setRegion({ x: left, y: top, w: right - left, h: bottom - top }, false);
          };

          const onUp = (ue) => {
            ue?.preventDefault?.();
            ue?.stopPropagation?.();
            dragAbort.abort();
            if (didDrag) {
              ctrl.persistCurrentRegion();
            }
          };

          const dragSignal = typeof AbortSignal !== "undefined" && AbortSignal.any
            ? AbortSignal.any([signal, dragAbort.signal])
            : dragAbort.signal;
          this.win.addEventListener("mousemove", onMove, { capture: true, signal: dragSignal });
          this.win.addEventListener("mouseup", onUp, { capture: true, signal: dragSignal });
          this.win.addEventListener("blur", onUp, { signal: dragSignal });
        },
        { signal }
      );
    }

    updateMinimapSize() {
      if (!this.minimapEl || !this.minimapCanvas) return;
      const dims = this.#controller.getOriginalDimensions();
      const aspect = clamp(dims.width / Math.max(1, dims.height), 0.75, 4.2);
      const w = 312;
      const h = Math.round(clamp(w / aspect, 78, 176));
      this.minimapEl.style.height = `${h}px`;
      if (this.minimapCanvas.width !== w * 2 || this.minimapCanvas.height !== h * 2) {
        this.minimapCanvas.width = w * 2;
        this.minimapCanvas.height = h * 2;
      }
    }

    startMinimapLoop() {
      this.stopMinimapLoop();
      this.#controller.ensureSourceMonitor();

      const tick = (ts) => {
        if (!this.isOpen) return;
        if (ts - this.#lastMinimapTs >= 75) {
          this.#lastMinimapTs = ts;
          this.drawMinimap();
        }
        this.#minimapRaf = requestAnimFrame(this.win, tick);
      };
      this.drawMinimap();
      this.#minimapRaf = requestAnimFrame(this.win, tick);
    }

    stopMinimapLoop() {
      if (this.#minimapRaf) {
        cancelAnimFrame(this.win, this.#minimapRaf);
        this.#minimapRaf = 0;
      }
    }

    drawMinimap() {
      if (!this.minimapCanvas) return;
      this.updateMinimapSize();
      const srcVideo = isFullRegion(this.#controller.region)
        ? this.#controller.video
        : this.#controller.ensureSourceMonitor();
      try {
        const ctx = this.minimapCanvas.getContext("2d");
        ctx?.drawImage(srcVideo, 0, 0, this.minimapCanvas.width, this.minimapCanvas.height);
      } catch {
        // Source video has not decoded its first frame yet.
      }
    }

    // Opens a large view of the uncropped monitor so you can drag a box around a
    // specific game window or editor pane even while the stream is already cropped.
    openDrawModal() {
      if (this.isDrawing) return;
      this.isDrawing = true;
      this.closeHud();

      const ctrl = this.#controller;
      const doc = this.doc;
      const win = this.win;
      const monitor = isFullRegion(ctrl.region) ? ctrl.video : ctrl.ensureSourceMonitor();
      const dims = ctrl.getOriginalDimensions();
      const aspect = clamp(dims.width / Math.max(1, dims.height), 0.5, 5);

      const mountTarget = getModalMountTarget(doc);
      if (!mountTarget) {
        this.isDrawing = false;
        return;
      }

      const computeStageDimensions = (target) => {
        const isFs = Boolean(getActiveFullscreenElement(doc));
        const rect = isFs && target?.getBoundingClientRect ? target.getBoundingClientRect() : null;
        const viewportW = (isFs ? (target?.clientWidth || rect?.width) : 0) || win.innerWidth || 1920;
        const viewportH = (isFs ? (target?.clientHeight || rect?.height) : 0) || win.innerHeight || 1080;
        const maxW = Math.min(viewportW * 0.9, isFs ? viewportW * 0.92 : 1400);
        const maxH = Math.min(viewportH * 0.78, isFs ? viewportH * 0.8 : 820);
        let sw = maxW;
        let sh = sw / aspect;
        if (sh > maxH) {
          sh = maxH;
          sw = sh * aspect;
        }
        return {
          stageW: Math.max(240, Math.round(sw)),
          stageH: Math.max(140, Math.round(sh))
        };
      };

      const { stageW: initialStageW, stageH: initialStageH } = computeStageDimensions(mountTarget);

      this.#modalAbort = new AbortController();
      const { signal } = this.#modalAbort;

      const modal = doc.createElement("div");
      modal.className = "dsc-draw-modal";
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Draw custom stream crop region");
      shieldPlayerEvents(modal, signal);

      const bar = doc.createElement("div");
      bar.className = "dsc-draw-modal-bar";
      const barText = doc.createElement("span");
      barText.textContent = `Drag across the part of the ${dims.width}×${dims.height} stream you want to watch`;
      bar.appendChild(barText);

      if (!isFullRegion(ctrl.region)) {
        const modalResetBtn = doc.createElement("button");
        modalResetBtn.type = "button";
        modalResetBtn.className = "dsc-icon-btn dsc-modal-reset-btn";
        modalResetBtn.title = "Restore uncropped stream";
        modalResetBtn.innerHTML = `${ICONS.reset}<span>Reset to Full Stream</span>`;
        modalResetBtn.addEventListener("click", () => ctrl.reset(), { signal });
        bar.appendChild(modalResetBtn);
      }

      const cancelBtn = doc.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "dsc-icon-btn";
      cancelBtn.textContent = "Cancel (Esc)";
      cancelBtn.addEventListener("click", () => this.closeDrawModal(), { signal });
      bar.appendChild(cancelBtn);

      const stage = doc.createElement("div");
      stage.className = "dsc-draw-stage";

      const canvas = doc.createElement("canvas");
      canvas.className = "dsc-draw-stage-canvas";

      const applyStageDimensions = (sw, sh) => {
        stage.style.width = `${sw}px`;
        stage.style.height = `${sh}px`;
        canvas.width = sw * 2;
        canvas.height = sh * 2;
        canvas.style.width = `${sw}px`;
        canvas.style.height = `${sh}px`;
      };
      applyStageDimensions(initialStageW, initialStageH);

      const selBox = doc.createElement("div");
      selBox.className = "dsc-draw-selection";

      const readout = doc.createElement("div");
      readout.className = "dsc-draw-readout";
      selBox.appendChild(readout);

      stage.append(canvas, selBox);
      modal.append(bar, stage);

      const ctx = canvas.getContext("2d");
      const drawPreview = () => {
        if (!this.isDrawing) return;
        try {
          ctx?.drawImage(monitor, 0, 0, canvas.width, canvas.height);
        } catch {}
        this.#drawModalRaf = requestAnimFrame(win, drawPreview);
      };

      let startX = 0;
      let startY = 0;
      let dragging = false;

      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        e.stopPropagation();
        const bounds = stage.getBoundingClientRect();
        const cx = clamp(e.clientX - bounds.left, 0, bounds.width);
        const cy = clamp(e.clientY - bounds.top, 0, bounds.height);

        const x1 = Math.min(startX, cx);
        const y1 = Math.min(startY, cy);
        const w = Math.max(1, Math.abs(cx - startX));
        const h = Math.max(1, Math.abs(cy - startY));

        selBox.style.left = `${x1}px`;
        selBox.style.top = `${y1}px`;
        selBox.style.width = `${w}px`;
        selBox.style.height = `${h}px`;

        const outRect = computePixelCropRect(
          { x: x1 / bounds.width, y: y1 / bounds.height, w: w / bounds.width, h: h / bounds.height },
          dims.width,
          dims.height
        );
        readout.textContent = `${outRect.width} × ${outRect.height}`;
      };

      let dragAbort = null;

      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        dragAbort?.abort();
        dragAbort = null;
        e?.preventDefault?.();
        e?.stopPropagation?.();
        if (!e || typeof e.clientX !== "number") {
          selBox.style.display = "none";
          return;
        }

        const bounds = stage.getBoundingClientRect();
        const ex = clamp(e.clientX - bounds.left, 0, bounds.width);
        const ey = clamp(e.clientY - bounds.top, 0, bounds.height);
        const x1 = Math.min(startX, ex);
        const y1 = Math.min(startY, ey);
        const w = Math.abs(ex - startX);
        const h = Math.abs(ey - startY);

        if (w < 14 || h < 14 || bounds.width <= 0 || bounds.height <= 0) {
          selBox.style.display = "none";
          return;
        }

        this.closeDrawModal();

        ctrl.activePreset = "custom";
        ctrl.setRegion({
          x: x1 / bounds.width,
          y: y1 / bounds.height,
          w: w / bounds.width,
          h: h / bounds.height
        });
      };

      stage.addEventListener(
        "mousedown",
        (e) => {
          if (e.button !== undefined && e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          dragAbort?.abort();
          dragAbort = new AbortController();
          const dragSignal = typeof AbortSignal !== "undefined" && AbortSignal.any
            ? AbortSignal.any([signal, dragAbort.signal])
            : dragAbort.signal;

          const bounds = stage.getBoundingClientRect();
          startX = clamp(e.clientX - bounds.left, 0, bounds.width);
          startY = clamp(e.clientY - bounds.top, 0, bounds.height);
          dragging = true;
          selBox.style.display = "block";
          selBox.style.left = `${startX}px`;
          selBox.style.top = `${startY}px`;
          selBox.style.width = "1px";
          selBox.style.height = "1px";

          win.addEventListener("mousemove", onMove, { capture: true, signal: dragSignal });
          win.addEventListener("mouseup", onUp, { capture: true, signal: dragSignal });
          win.addEventListener("blur", () => onUp(null), { signal: dragSignal });
        },
        { signal }
      );

      modal.addEventListener(
        "click",
        (e) => {
          if (e.target === modal) this.closeDrawModal();
        },
        { signal }
      );

      const syncFullscreenMount = () => {
        if (!this.isDrawing || this.drawModalEl !== modal) return;
        const nextTarget = getModalMountTarget(doc);
        if (nextTarget && modal.parentElement !== nextTarget) {
          nextTarget.appendChild(modal);
        }
        if (nextTarget && !dragging) {
          const { stageW: nextW, stageH: nextH } = computeStageDimensions(nextTarget);
          applyStageDimensions(nextW, nextH);
        }
      };

      doc.addEventListener("fullscreenchange", syncFullscreenMount, { signal });
      doc.addEventListener("webkitfullscreenchange", syncFullscreenMount, { signal });

      mountTarget.appendChild(modal);
      this.drawModalEl = modal;
      cancelBtn.focus?.();
      drawPreview();
    }

    closeDrawModal() {
      if (!this.isDrawing && !this.drawModalEl) return;
      this.isDrawing = false;
      if (this.#drawModalRaf) {
        cancelAnimFrame(this.win, this.#drawModalRaf);
        this.#drawModalRaf = 0;
      }
      this.#modalAbort?.abort();
      this.#modalAbort = null;
      this.drawModalEl?.remove();
      this.drawModalEl = null;
      if (isFullRegion(this.#controller.region) && !this.isOpen) {
        this.#controller.destroySourceMonitor();
      }
    }

    toggleHud() {
      if (this.isOpen) {
        this.closeHud();
        return;
      }
      if (this.#controller.shouldPreferDrawModal()) {
        this.openDrawModal();
        return;
      }
      this.openHud();
    }

    openHud() {
      this.isOpen = true;
      this.rootEl?.classList.add("dsc-open");
      this.triggerBtn?.setAttribute("aria-expanded", "true");
      this.updateMinimapSize();
      this.renderSavedPresets();
      this.sync();
      this.startMinimapLoop();
    }

    closeHud() {
      this.isOpen = false;
      this.stopMinimapLoop();
      this.rootEl?.classList.remove("dsc-open");
      this.triggerBtn?.setAttribute("aria-expanded", "false");
      if (isFullRegion(this.#controller.region) && !this.isDrawing) {
        this.#controller.destroySourceMonitor();
      }
    }

    containsTarget(target) {
      return !!(
        (this.rootEl && target && this.rootEl.contains(target)) ||
        (this.drawModalEl && target && this.drawModalEl.contains(target))
      );
    }

    sync() {
      if (!this.rootEl) return;
      const ctrl = this.#controller;
      const settings = ctrl.manager.settings;

      const compact = ctrl.isCompactHost();
      this.rootEl.classList.toggle("dsc-compact", compact);
      if (compact && this.isOpen && ctrl.shouldPreferDrawModal()) {
        this.closeHud();
      }

      this.rootEl.classList.toggle("dsc-pos-top-left", settings.buttonPosition === "top-left");

      const cropped = !isFullRegion(ctrl.region);
      this.triggerBtn?.classList.toggle("dsc-is-cropped", cropped);

      const dims = ctrl.getOriginalDimensions();
      const outRect = computePixelCropRect(ctrl.region, dims.width, dims.height);

      if (this.triggerResSpan) {
        this.triggerResSpan.textContent =
          cropped && settings.showResolutionBadge ? `${outRect.width}×${outRect.height}` : "";
      }

      if (this.metaSpan) {
        this.metaSpan.textContent = cropped
          ? `${outRect.width}×${outRect.height} (from ${dims.width}×${dims.height})`
          : `${dims.width}×${dims.height}`;
      }

      for (const [id, btn] of this.#presetBtns) {
        const selected = ctrl.activePreset === id;
        btn.classList.toggle("dsc-selected", selected);
        btn.setAttribute("aria-pressed", String(selected));
      }

      if (this.minimapBox) {
        this.minimapBox.style.left = `${(ctrl.region.x * 100).toFixed(2)}%`;
        this.minimapBox.style.top = `${(ctrl.region.y * 100).toFixed(2)}%`;
        this.minimapBox.style.width = `${(ctrl.region.w * 100).toFixed(2)}%`;
        this.minimapBox.style.height = `${(ctrl.region.h * 100).toFixed(2)}%`;
      }
    }

    renderSavedPresets() {
      if (!this.savedRowEl) return;
      this.#presetRenderAbort?.abort();
      this.#presetRenderAbort = null;

      const list = this.#controller.manager.savedPresets;
      this.savedRowEl.innerHTML = "";

      if (!list.length) {
        this.savedRowEl.style.display = "none";
        return;
      }
      this.savedRowEl.style.display = "flex";

      this.#presetRenderAbort = new AbortController();
      const presetSignal = typeof AbortSignal !== "undefined" && AbortSignal.any
        ? AbortSignal.any([this.#listeners.signal, this.#presetRenderAbort.signal])
        : this.#presetRenderAbort.signal;

      for (const [idx, item] of list.entries()) {
        const pill = this.doc.createElement("div");
        pill.className = "dsc-saved-pill";

        const applyBtn = this.doc.createElement("button");
        applyBtn.type = "button";
        applyBtn.className = "dsc-saved-apply";
        applyBtn.textContent = item.name;
        applyBtn.title = `Apply "${item.name}"`;
        applyBtn.addEventListener("click", () => {
          this.#controller.activePreset = "custom";
          this.#controller.setRegion(item.region);
        }, { signal: presetSignal });

        const delBtn = this.doc.createElement("button");
        delBtn.type = "button";
        delBtn.className = "dsc-saved-del";
        delBtn.textContent = "×";
        delBtn.title = `Delete "${item.name}"`;
        delBtn.setAttribute("aria-label", `Delete preset ${item.name}`);
        delBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.#controller.manager.deletePreset(idx);
        }, { signal: presetSignal });

        pill.append(applyBtn, delBtn);
        this.savedRowEl.appendChild(pill);
      }
    }

    destroy() {
      this.closeDrawModal();
      this.stopMinimapLoop();
      this.#presetRenderAbort?.abort();
      this.#presetRenderAbort = null;
      this.#listeners.abort();

      for (const tip of this.#tooltips) {
        try {
          tip?.destroy?.();
        } catch {}
      }
      this.#tooltips = [];

      this.rootEl?.remove();
      this.rootEl = null;
    }
  }

  // Owns the `<video>` stream lifecycle: intercepting React `srcObject` re-renders,
  // maintaining the `MediaStreamCropSession`, and recalling per-streamer crops.
  class VideoSourceController {
    #listeners = new AbortController();
    #hostListeners = null;
    #hostResizeObserver = null;
    #nativeSrcDesc = null;
    #offRemoved = null;
    #hoverTimer = null;
    #didAutoCrop = false;
    #autoCenteredTentative = false;
    #explicitUserReset = false;
    #pendingUncroppedResize = false;
    #lastEvaluatedAspect = 0;
    #knownSourceSize = { width: 0, height: 0 };
    #knownStreamers = [];

    constructor(video, manager) {
      this.video = video;
      this.manager = manager;
      this.doc = video.ownerDocument || document;
      this.win = this.doc.defaultView || window;

      this.originalStream = video.srcObject;
      this.cropSession = null;

      // Secondary muted <video> attached to the uncropped `originalStream` so our
      // minimap and Draw Custom Region modal still show the full monitor even
      // after `this.video.srcObject` has been swapped to the cropped stream.
      this.sourceMonitorVideo = null;

      this.region = { ...FULL_REGION };
      this.activePreset = "full";
      this.host = null;
      this.promotedHostPos = false;
      this.overlay = new StreamCropOverlay(this);
    }

    get isOpen() {
      return this.overlay.isOpen;
    }

    get isDrawing() {
      return this.overlay.isDrawing;
    }

    closeHud() {
      this.overlay.closeHud();
    }

    closeDrawModal() {
      this.overlay.closeDrawModal();
    }

    handleOutsidePointer(event) {
      if (this.overlay.isOpen && !this.overlay.containsTarget(event.target)) {
        this.overlay.closeHud();
      }
    }

    syncUI() {
      this.overlay.sync();
    }

    renderSavedPresets() {
      this.overlay.renderSavedPresets();
    }

    getHostDimensions() {
      const target = this.host || this.video;
      if (!target) return { width: 0, height: 0 };
      const rect = target.getBoundingClientRect();
      return {
        width: target.clientWidth || rect.width || 0,
        height: target.clientHeight || rect.height || 0
      };
    }

    isCompactHost() {
      const { width, height } = this.getHostDimensions();
      return (width > 0 && width < COMPACT_HOST_WIDTH) || (height > 0 && height < COMPACT_HOST_HEIGHT);
    }

    shouldPreferDrawModal() {
      const { width, height } = this.getHostDimensions();
      return (width > 0 && width < MODAL_ONLY_HOST_WIDTH) || (height > 0 && height < COMPACT_HOST_HEIGHT);
    }

    // Climb out of the inner `<video>` flex box so the `Crop` button sits in the
    // top corner of the full stream stage, but stop before climbing into the outer
    // call container that also wraps the participant avatar row at the bottom.
    resolveHostContainer() {
      return resolvePlayerHostForVideo(this.video, this.doc);
    }

    attachHost(nextHost) {
      if (!nextHost || nextHost === this.host) return;

      this.#hostListeners?.abort();
      this.#hostListeners = null;
      this.#hostResizeObserver?.disconnect?.();
      this.#hostResizeObserver = null;

      if (this.host) {
        this.host.classList.remove("dsc-host-hover");
        if (this.promotedHostPos) {
          this.host.classList.remove("dsc-host-positioned");
          this.promotedHostPos = false;
        }
      }

      this.host = nextHost;
      const pos = this.win.getComputedStyle(nextHost).position;
      if (!pos || pos === "static") {
        nextHost.classList.add("dsc-host-positioned");
        this.promotedHostPos = true;
      }

      if (this.overlay.rootEl) {
        nextHost.appendChild(this.overlay.rootEl);
        this.watchOverlayRemoval();
      }

      this.#hostListeners = new AbortController();
      const hostSignal = typeof AbortSignal !== "undefined" && AbortSignal.any
        ? AbortSignal.any([this.#listeners.signal, this.#hostListeners.signal])
        : this.#hostListeners.signal;
      nextHost.addEventListener("mouseenter", () => this.setHover(true), { signal: hostSignal });
      nextHost.addEventListener("mousemove", () => this.bumpHover(), { passive: true, signal: hostSignal });
      nextHost.addEventListener("mouseleave", () => this.setHover(false), { signal: hostSignal });

      const ResizeObserverCtor = this.win?.ResizeObserver ?? (typeof ResizeObserver === "function" ? ResizeObserver : null);
      if (ResizeObserverCtor) {
        this.#hostResizeObserver = new ResizeObserverCtor(() => {
          if (this.video.isConnected) this.syncUI();
        });
        this.#hostResizeObserver.observe(nextHost);
      }
    }

    recheckHostContainer() {
      if (!this.video.isConnected) return;
      const nextHost = this.resolveHostContainer();
      if (!nextHost) return;
      if (nextHost !== this.host) {
        this.attachHost(nextHost);
      } else if (this.overlay.rootEl && !this.overlay.rootEl.isConnected) {
        this.host.appendChild(this.overlay.rootEl);
        this.watchOverlayRemoval();
      }
      this.syncUI();
    }

    mount() {
      const host = this.resolveHostContainer();
      if (!host) return false;

      this.installVideoSrcHook();
      this.overlay.build();
      this.attachHost(host);

      const { signal } = this.#listeners;
      const onFullscreenChange = () => this.recheckHostContainer();
      const onUncroppedFrameDecoded = () => {
        if (isFullRegion(this.region)) {
          this.#pendingUncroppedResize = false;
        }
        this.handleStreamMetadata();
      };
      this.doc.addEventListener("fullscreenchange", onFullscreenChange, { signal });
      this.doc.addEventListener("webkitfullscreenchange", onFullscreenChange, { signal });
      this.win?.addEventListener?.("resize", onFullscreenChange, { passive: true, signal });
      this.video.addEventListener("loadedmetadata", onUncroppedFrameDecoded, { signal });
      this.video.addEventListener("loadeddata", onUncroppedFrameDecoded, { signal });
      this.video.addEventListener("playing", () => this.handleStreamMetadata(), { signal });
      this.video.addEventListener("resize", onUncroppedFrameDecoded, { signal });

      this.handleStreamMetadata();
      this.syncUI();
      return true;
    }

    setNativeSrcObject(stream) {
      if (this.#nativeSrcDesc?.set) {
        this.#nativeSrcDesc.set.call(this.video, stream);
      } else {
        this.video.srcObject = stream;
      }
    }

    getNativeSrcObject() {
      return this.#nativeSrcDesc?.get
        ? this.#nativeSrcDesc.get.call(this.video)
        : this.video.srcObject;
    }

    // Discord's React tree periodically re-renders the player and re-runs
    // `video.srcObject = originalStream`. We shadow `srcObject` on this single
    // `<video>` instance (never on HTMLMediaElement.prototype) so React re-renders
    // don't clobber an active crop, while genuine stream switches are caught cleanly.
    installVideoSrcHook() {
      this.removeVideoSrcHook();

      let desc = null;
      let proto = Object.getPrototypeOf(this.video);
      while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, "srcObject");
        proto = Object.getPrototypeOf(proto);
      }
      if (!desc?.get || !desc?.set) return;

      this.#nativeSrcDesc = desc;
      const controller = this;

      Object.defineProperty(this.video, "srcObject", {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          return desc.get.call(this);
        },
        set(incomingStream) {
          if (incomingStream && CROPPED_STREAMS.has(incomingStream)) {
            desc.set.call(this, incomingStream);
            return;
          }

          if (!incomingStream) {
            controller.teardownCropSession(false);
            controller.originalStream = null;
            desc.set.call(this, null);
            return;
          }

          if (controller.originalStream && incomingStream === controller.originalStream) {
            desc.set.call(this, controller.cropSession?.outputStream ?? incomingStream);
            return;
          }

          controller.adoptIncomingStream(incomingStream, (s) => desc.set.call(this, s));
        }
      });
    }

    adoptIncomingStream(incomingStream, applyRawStream) {
      this.originalStream = incomingStream;
      this.#didAutoCrop = false;
      this.#autoCenteredTentative = false;
      this.#explicitUserReset = false;
      this.#pendingUncroppedResize = false;
      this.#lastEvaluatedAspect = 0;
      this.#knownSourceSize = { width: 0, height: 0 };
      this.#knownStreamers = [];
      if (this.sourceMonitorVideo) {
        this.sourceMonitorVideo.srcObject = incomingStream;
      }

      const recalled = this.manager.recallStreamCrop(this.getStreamIdentities(), {
        allowRecentHandoff: true,
        isPopout: this.doc !== document
      });
      if (recalled?.isReset) {
        this.#didAutoCrop = true;
        this.#explicitUserReset = true;
      } else if (recalled && !isFullRegion(recalled.region)) {
        this.region = normalizeRegion(recalled.region);
        this.activePreset = recalled.preset || "custom";
        this.#didAutoCrop = true;
        this.rebuildCropSession();
        this.syncUI();
        return;
      }

      // Don't carry someone's ultrawide crop over onto a different streamer's 16:9 feed.
      this.teardownCropSession(false);
      this.region = { ...FULL_REGION };
      this.activePreset = "full";
      applyRawStream?.(incomingStream);
      this.handleStreamMetadata();
      this.syncUI();
    }

    removeVideoSrcHook() {
      if (!this.#nativeSrcDesc) return;
      try {
        delete this.video.srcObject;
      } catch {}
      this.#nativeSrcDesc = null;
    }

    ensureMounted() {
      if (!this.host?.isConnected) {
        this.recheckHostContainer();
        if (!this.host?.isConnected) return;
      } else {
        const resolved = this.resolveHostContainer();
        if (resolved && resolved !== this.host) {
          this.attachHost(resolved);
        } else if (this.overlay.rootEl && !this.overlay.rootEl.isConnected) {
          this.host.appendChild(this.overlay.rootEl);
          this.watchOverlayRemoval();
        }
        this.syncUI();
      }

      const current = this.getNativeSrcObject();
      if (current && !CROPPED_STREAMS.has(current) && current !== this.originalStream) {
        this.adoptIncomingStream(current, null);
        return;
      }

      // Retry auto-recall on subsequent scans/mutations if the streamer badge or
      // video dimensions arrived asynchronously after initial mount (or after a tentative auto-center)!
      if ((!this.#didAutoCrop && isFullRegion(this.region)) || this.#autoCenteredTentative) {
        this.handleStreamMetadata();
      }
    }

    watchOverlayRemoval() {
      this.#offRemoved?.();
      this.#offRemoved = null;
      const rootEl = this.overlay.rootEl;
      if (!rootEl || this.doc !== document || !this.manager.api.DOM.onRemoved) return;

      this.#offRemoved = this.manager.api.DOM.onRemoved(rootEl, () => {
        // If Discord moved `<video>` into a Popout Window, `video.ownerDocument` changed—
        // trigger a full scan instead of appending a main-document overlay into the popout!
        if (this.video.ownerDocument !== this.doc) {
          this.manager.scheduleScan();
          return;
        }
        if (this.video.isConnected && this.overlay.rootEl) {
          this.recheckHostContainer();
        }
      });
    }

    destroy() {
      // Snapshot active crop OR explicit user Reset before unmounting so Main <-> Popout
      // window transitions hand off seamlessly even when Discord creates a new MediaStream wrapper!
      if (!isFullRegion(this.region) || this.#explicitUserReset) {
        this.manager.recordStreamHandoff(
          this.getStreamIdentities(),
          this.region,
          this.activePreset,
          this.doc !== document
        );
      }

      this.#offRemoved?.();
      this.#offRemoved = null;

      clearTimeout(this.#hoverTimer);
      this.#hoverTimer = null;

      this.#hostResizeObserver?.disconnect?.();
      this.#hostResizeObserver = null;
      this.#hostListeners?.abort();
      this.#hostListeners = null;
      this.#listeners.abort();
      this.removeVideoSrcHook();
      this.teardownCropSession(true);
      this.destroySourceMonitor();
      this.overlay.destroy();

      if (this.host) {
        this.host.classList.remove("dsc-host-hover");
        if (this.promotedHostPos) {
          this.host.classList.remove("dsc-host-positioned");
          this.promotedHostPos = false;
        }
        this.host = null;
      }
    }

    extractStreamerLabels() {
      const liveLabels = extractStreamerLabels(
        this.host,
        this.doc !== document ? this.doc : null,
        this.overlay.rootEl
      );
      // Append newly seen labels rather than unshifting transient hover text ahead of the primary streamer!
      for (const lbl of liveLabels) {
        if (!this.#knownStreamers.includes(lbl)) {
          this.#knownStreamers.push(lbl);
        }
      }
      if (this.#knownStreamers.length > 6) {
        this.#knownStreamers.length = 6;
      }
      return liveLabels.length ? liveLabels : [...this.#knownStreamers];
    }

    getIntrinsicStreamDimensions() {
      let width = 0;
      let height = 0;

      if (this.cropSession?.lastSourceSize?.width > 0 && this.cropSession?.lastSourceSize?.height > 0) {
        width = this.cropSession.lastSourceSize.width;
        height = this.cropSession.lastSourceSize.height;
      } else if (this.sourceMonitorVideo?.videoWidth > 0 && this.sourceMonitorVideo?.videoHeight > 0) {
        width = this.sourceMonitorVideo.videoWidth;
        height = this.sourceMonitorVideo.videoHeight;
      } else {
        const [vTrack] = this.originalStream?.getVideoTracks?.() ?? [];
        const settings = vTrack?.getSettings?.();
        if (settings?.width > 0 && settings?.height > 0) {
          width = settings.width;
          height = settings.height;
        } else if (
          isFullRegion(this.region) &&
          !this.#pendingUncroppedResize &&
          this.video.videoWidth > 0 &&
          this.video.videoHeight > 0
        ) {
          width = this.video.videoWidth;
          height = this.video.videoHeight;
        }
      }

      if (width > 0 && height > 0) {
        this.#knownSourceSize = { width, height };
        return { width, height };
      }

      return { ...this.#knownSourceSize };
    }

    getStreamIdentities() {
      return buildStreamIdentities(
        this.originalStream,
        this.getIntrinsicStreamDimensions(),
        this.extractStreamerLabels()
      );
    }

    handleStreamMetadata() {
      // Refresh cached streamer labels & source dimensions whenever metadata/frames arrive
      this.extractStreamerLabels();
      const intrinsic = this.getIntrinsicStreamDimensions();
      const aspect = intrinsic.width / Math.max(1, intrinsic.height);

      // If streamer switched from sharing a 16:9 app to sharing their 32:9 ultrawide monitor
      // mid-stream on the same `<video>` (and user hadn't explicitly reset), re-evaluate recall/auto-center!
      if (
        this.#didAutoCrop &&
        !this.#explicitUserReset &&
        isFullRegion(this.region) &&
        intrinsic.width > 0 &&
        this.#lastEvaluatedAspect > 0 &&
        Math.abs(aspect - this.#lastEvaluatedAspect) > 0.35
      ) {
        this.#didAutoCrop = false;
      }
      if (intrinsic.width > 0) {
        this.#lastEvaluatedAspect = aspect;
      }

      if ((!this.#didAutoCrop && isFullRegion(this.region)) || this.#autoCenteredTentative) {
        const identities = this.getStreamIdentities();
        const recalled = this.manager.recallStreamCrop(identities, {
          allowRecentHandoff: true,
          isPopout: this.doc !== document
        });
        if (recalled?.isReset) {
          this.#didAutoCrop = true;
          this.#explicitUserReset = true;
          if (this.#autoCenteredTentative) {
            this.#autoCenteredTentative = false;
            this.reset(false);
          } else {
            this.syncUI();
          }
          return;
        }
        if (recalled && !isFullRegion(recalled.region)) {
          this.#didAutoCrop = true;
          this.#autoCenteredTentative = false;
          this.region = normalizeRegion(recalled.region);
          this.activePreset = recalled.preset || "custom";
          this.applySourceCrop();
          this.syncUI();
          return;
        }
        if (this.#autoCenteredTentative && identities.primaryStreamer) {
          // Badge arrived and streamer has no saved entry -> lock in the unpersisted auto-center
          this.#autoCenteredTentative = false;
        }
      }

      if (
        !this.#didAutoCrop &&
        !this.#explicitUserReset &&
        this.manager.settings.autoCenterUltrawide &&
        isFullRegion(this.region) &&
        intrinsic.width > 0 &&
        aspect > 2.15
      ) {
        const identities = this.getStreamIdentities();
        this.#didAutoCrop = true;
        // Mark tentative if the streamer name badge hasn't rendered yet so a late-arriving
        // badge with an explicit `isReset` tombstone (or custom crop) still wins!
        this.#autoCenteredTentative = !identities.primaryStreamer;
        // CRITICAL: `persist = false` so auto-center NEVER writes fake manual crops to disk!
        this.applyPreset("center", false);
        return;
      }

      this.syncUI();
    }

    setHover(hovered) {
      if (!this.host) return;
      if (hovered) {
        this.bumpHover();
      } else {
        clearTimeout(this.#hoverTimer);
        this.#hoverTimer = null;
        this.host.classList.remove("dsc-host-hover");
      }
    }

    bumpHover() {
      if (!this.host) return;
      this.host.classList.add("dsc-host-hover");
      clearTimeout(this.#hoverTimer);
      this.#hoverTimer = setTimeout(() => {
        if (this.host && !this.isOpen) {
          this.host.classList.remove("dsc-host-hover");
        }
      }, 2200);
    }

    getOriginalDimensions() {
      const intrinsic = this.getIntrinsicStreamDimensions();
      if (intrinsic.width > 0 && intrinsic.height > 0) {
        return intrinsic;
      }

      return {
        width: this.video.videoWidth || this.video.clientWidth || 1920,
        height: this.video.videoHeight || this.video.clientHeight || 1080
      };
    }

    ensureSourceMonitor() {
      if (this.sourceMonitorVideo) {
        if (this.originalStream && this.sourceMonitorVideo.srcObject !== this.originalStream) {
          this.sourceMonitorVideo.srcObject = this.originalStream;
        }
        return this.sourceMonitorVideo;
      }

      const monitor = this.doc.createElement("video");
      monitor.dataset.dscInternal = "true";
      monitor.muted = true;
      monitor.autoplay = true;
      monitor.playsInline = true;
      if (this.originalStream) monitor.srcObject = this.originalStream;
      monitor.play()?.catch(() => {});
      this.sourceMonitorVideo = monitor;
      return monitor;
    }

    destroySourceMonitor() {
      if (!this.sourceMonitorVideo) return;
      this.sourceMonitorVideo.pause();
      this.sourceMonitorVideo.srcObject = null;
      this.sourceMonitorVideo = null;
    }

    applySourceCrop() {
      if (isFullRegion(this.region)) {
        this.teardownCropSession(true);
        return;
      }

      if (!this.originalStream) {
        const cur = this.getNativeSrcObject();
        if (cur && !CROPPED_STREAMS.has(cur)) this.originalStream = cur;
      }
      if (!this.originalStream) return;

      if (this.isOpen || this.isDrawing) {
        this.ensureSourceMonitor();
      }

      // Mutate crop bounds live on the active session without reconstructing the MediaStream.
      if (this.cropSession && !this.cropSession.disposed && this.cropSession.sourceStream === this.originalStream) {
        this.cropSession.setRegion(this.region);
        return;
      }

      this.rebuildCropSession();
    }

    rebuildCropSession() {
      if (this.cropSession) {
        this.cropSession.stop();
        this.cropSession = null;
      }
      if (!this.originalStream || isFullRegion(this.region)) return;

      const session = new MediaStreamCropSession(this.originalStream, this.region, {
        doc: this.doc,
        win: this.win,
        onStreamReplaced: (fallbackStream) => {
          if (this.cropSession !== session || !this.video.isConnected) return;
          this.setNativeSrcObject(fallbackStream);
          this.video.play()?.catch(() => {});
        },
        onVideoTrackEnded: () => {
          if (this.cropSession !== session || !this.video.isConnected) return;
          const liveVideoTracks = (this.originalStream?.getVideoTracks?.() ?? []).filter(
            (t) => t.readyState !== "ended"
          );
          if (liveVideoTracks.length > 0 && !isFullRegion(this.region)) {
            this.rebuildCropSession();
          } else {
            this.teardownCropSession(true);
          }
        }
      });
      const croppedStream = session.start();
      if (!croppedStream) return;

      this.#pendingUncroppedResize = false;
      this.cropSession = session;
      this.setNativeSrcObject(croppedStream);
      this.video.play()?.catch(() => {});
    }

    teardownCropSession(restoreOriginal) {
      const hadSession = !!this.cropSession;
      if (this.cropSession) {
        // Preserve true source dimensions from the crop session BEFORE stopping/nulling it!
        if (this.cropSession.lastSourceSize?.width > 0 && this.cropSession.lastSourceSize?.height > 0) {
          this.#knownSourceSize = { ...this.cropSession.lastSourceSize };
        }
        this.cropSession.stop();
        this.cropSession = null;
      }
      if (this.sourceMonitorVideo?.videoWidth > 0 && this.sourceMonitorVideo?.videoHeight > 0) {
        this.#knownSourceSize = {
          width: this.sourceMonitorVideo.videoWidth,
          height: this.sourceMonitorVideo.videoHeight
        };
      }
      if (!this.isOpen && !this.isDrawing) {
        this.destroySourceMonitor();
      }
      if (restoreOriginal && hadSession && this.originalStream && this.video.isConnected) {
        // Guard against reading stale cropped `this.video.videoWidth` until `originalStream` decodes its next frame!
        this.#pendingUncroppedResize = true;
        this.setNativeSrcObject(this.originalStream);
        this.video.play()?.catch(() => {});
      }
    }

    persistCurrentRegion() {
      this.manager.rememberStreamCrop(this.getStreamIdentities(), this.region, this.activePreset, this);
    }

    setRegion(nextRegion, persist = true) {
      // Capture identities BEFORE mutating `this.region` / tearing down `cropSession`
      // so stale cropped `video.videoWidth` never corrupts source dimensions!
      const identities = persist ? this.getStreamIdentities() : null;
      this.region = normalizeRegion(nextRegion);
      this.#autoCenteredTentative = false;
      if (isFullRegion(this.region)) {
        this.activePreset = "full";
        this.#didAutoCrop = true;
        if (persist) this.#explicitUserReset = true;
      } else {
        this.#explicitUserReset = false;
      }
      this.applySourceCrop();
      if (persist && identities) {
        this.manager.rememberStreamCrop(identities, this.region, this.activePreset, this);
      }
      this.syncUI();
    }

    applyPreset(presetId, persist = true) {
      if (presetId === "full") {
        this.reset(persist);
        return;
      }
      const dims = this.getOriginalDimensions();
      const aspect = dims.width / Math.max(1, dims.height);
      const identities = persist ? this.getStreamIdentities() : null;
      this.activePreset = presetId;
      if (persist) {
        this.#autoCenteredTentative = false;
        this.#explicitUserReset = false;
      }
      this.region = computeSourcePreset(
        presetId,
        aspect,
        this.manager.settings.defaultSliceAspect
      );
      this.applySourceCrop();
      if (persist && identities) {
        this.manager.rememberStreamCrop(identities, this.region, this.activePreset, this);
      }
      this.syncUI();
    }

    reset(persist = true) {
      // CRITICAL: Capture `identities` BEFORE `closeDrawModal()` / `teardownCropSession()`
      // while `cropSession.lastSourceSize` and `sourceMonitorVideo` are still alive!
      const identities = persist ? this.getStreamIdentities() : null;
      this.closeDrawModal();
      this.region = { ...FULL_REGION };
      this.activePreset = "full";
      this.#didAutoCrop = true;
      this.#autoCenteredTentative = false;
      if (persist) this.#explicitUserReset = true;
      this.teardownCropSession(true);
      if (persist && identities) {
        this.manager.rememberStreamCrop(identities, this.region, "full", this);
      }
      this.syncUI();
    }
  }

  StreamCropper.computePixelCropRect = computePixelCropRect;
  StreamCropper.computeSourcePreset = computeSourcePreset;
  StreamCropper.getModalMountTarget = getModalMountTarget;
  StreamCropper.MediaStreamCropSession = MediaStreamCropSession;
  StreamCropper.isMediaStream = isMediaStream;
  StreamCropper.isCroppedStream = (s) => Boolean(s && CROPPED_STREAMS.has(s));

  if (typeof module !== "undefined" && module.exports) {
    module.exports = StreamCropper;
  }
})();
