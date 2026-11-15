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
  const MAX_REMEMBERED_STREAMS = 24;

  // Ignore small voice-call avatar loops, nitro badges, and bottom bar preview tiles.
  const MIN_STAGE_VIDEO_WIDTH = 200;
  const MIN_STAGE_VIDEO_HEIGHT = 150;

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
      gap: 4px;
      height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(43, 45, 49, 0.68);
      color: #dbdee1;
      font-size: 10.5px;
      font-weight: 600;
      cursor: pointer;
    }

    .dsc-saved-pill:hover {
      background: rgba(88, 101, 242, 0.35);
      border-color: rgba(88, 101, 242, 0.7);
      color: #ffffff;
    }

    .dsc-saved-del {
      opacity: 0.65;
      font-size: 12px;
      line-height: 1;
      padding-left: 2px;
    }

    .dsc-saved-del:hover {
      opacity: 1;
      color: #ff7b7f;
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

  function normalizeRegion(region) {
    const w = clamp(Number(region && region.w) || 1, MIN_CROP_FRACTION, 1);
    const h = clamp(Number(region && region.h) || 1, MIN_CROP_FRACTION, 1);
    const x = clamp(Number(region && region.x) || 0, 0, 1 - w);
    const y = clamp(Number(region && region.y) || 0, 0, 1 - h);
    return { x, y, w, h };
  }

  function isFullRegion(region) {
    if (!region) return true;
    return (
      region.x <= 0.002 &&
      region.y <= 0.002 &&
      region.w >= 0.996 &&
      region.h >= 0.996
    );
  }

  // Chromium's VideoFrame visibleRect requires even X/Y/width/height when the
  // underlying WebRTC decoder outputs 4:2:0 (I420 / NV12) planes; odd offsets
  // throw a DOMException on sub-sampled chroma planes.
  function computePixelCropRect(region, frameWidth, frameHeight) {
    const norm = normalizeRegion(region);
    const fw = Math.max(4, Math.floor(Number(frameWidth) || 1920));
    const fh = Math.max(4, Math.floor(Number(frameHeight) || 1080));

    const maxEvenW = fw % 2 === 0 ? fw : fw - 1;
    const maxEvenH = fh % 2 === 0 ? fh : fh - 1;

    const width = clamp(roundDownEven(norm.w * fw, 16), 2, maxEvenW);
    const height = clamp(roundDownEven(norm.h * fh, 16), 2, maxEvenH);

    let x = Math.round(norm.x * fw);
    let y = Math.round(norm.y * fh);
    if (x % 2 !== 0) x -= 1;
    if (y % 2 !== 0) y -= 1;

    x = clamp(x, 0, fw - width);
    y = clamp(y, 0, fh - height);
    if (x % 2 !== 0) x = Math.max(0, x - 1);
    if (y % 2 !== 0) y = Math.max(0, y - 1);

    return { x, y, width, height };
  }

  // Calculate normalized [0..1] crop regions for the quick-select buttons.
  // On a 32:9 display (5120x1440), Left / Center / Right carve out an exact
  // 16:9 slice (2560x1440). On a standard 16:9 stream, they grab half the width.
  function computeSourcePreset(presetId, streamAspect, defaultSliceAspect = "16:9") {
    if (presetId === "full") {
      return { ...FULL_REGION };
    }

    const sliceAspect = ASPECT_RATIOS[defaultSliceAspect] || 16 / 9;

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

    const w =
      streamAspect > sliceAspect * 1.08
        ? clamp(sliceAspect / streamAspect, MIN_CROP_FRACTION, 0.9)
        : 0.5;
    const h = 1;

    if (presetId === "left") return normalizeRegion({ x: 0, y: 0, w, h });
    if (presetId === "center") return normalizeRegion({ x: (1 - w) / 2, y: 0, w, h });
    if (presetId === "right") return normalizeRegion({ x: 1 - w, y: 0, w, h });

    return { ...FULL_REGION };
  }

  // Wraps a live WebRTC MediaStream and outputs a new MediaStream cropped to
  // `this.region`. Updating `this.region` mutates the crop on the fly for the
  // next frame without needing to rebuild the stream or re-assign `srcObject`.
  class MediaStreamCropSession {
    constructor(sourceStream, initialRegion) {
      this.sourceStream = sourceStream;
      this.region = normalizeRegion(initialRegion);
      this.outputStream = null;
      this.mode = "none";
      this.disposed = false;
      this.lastOutputSize = { width: 0, height: 0 };

      this._abortController = null;
      this._generator = null;
      this._hiddenVideo = null;
      this._canvas = null;
      this._rafId = null;
    }

    static supportsWebCodecs() {
      return (
        typeof MediaStreamTrackProcessor === "function" &&
        typeof MediaStreamTrackGenerator === "function" &&
        typeof VideoFrame === "function"
      );
    }

    start() {
      if (this.disposed) return null;
      const videoTracks = this.sourceStream.getVideoTracks ? this.sourceStream.getVideoTracks() : [];
      if (!videoTracks.length) return this.sourceStream;

      const videoTrack = videoTracks[0];
      const audioTracks = this.sourceStream.getAudioTracks ? this.sourceStream.getAudioTracks() : [];

      // Electron / Chromium supports insertable streams + VideoFrame out of the box,
      // which crops right on the GPU texture without a 2D canvas readback.
      if (MediaStreamCropSession.supportsWebCodecs()) {
        try {
          return this._startWebCodecs(videoTrack, audioTracks);
        } catch (_err) {
          // Fall back to canvas captureStream if the track format isn't supported.
        }
      }

      return this._startCanvasFallback(audioTracks);
    }

    setRegion(nextRegion) {
      this.region = normalizeRegion(nextRegion);
    }

    _startWebCodecs(videoTrack, audioTracks) {
      const processor = new MediaStreamTrackProcessor({ track: videoTrack });
      const generator = new MediaStreamTrackGenerator({ kind: "video" });
      this._generator = generator;
      this._abortController = typeof AbortController === "function" ? new AbortController() : null;

      const session = this;
      const transformer = new TransformStream({
        transform(frame, controller) {
          if (session.disposed) {
            frame.close();
            return;
          }
          try {
            const fw = frame.codedWidth || frame.displayWidth;
            const fh = frame.codedHeight || frame.displayHeight;
            const rect = computePixelCropRect(session.region, fw, fh);
            session.lastOutputSize = { width: rect.width, height: rect.height };

            const cropped = new VideoFrame(frame, {
              visibleRect: rect,
              timestamp: frame.timestamp,
              duration: frame.duration ?? undefined
            });
            controller.enqueue(cropped);
          } catch (_err) {
            // Mid-stream WebRTC resolution shifts can briefly race our rect math;
            // pass the uncropped frame through rather than dropping video.
            try {
              controller.enqueue(new VideoFrame(frame));
            } catch (_ignore) {
              // Frame was already closed or invalid.
            }
          } finally {
            // Always close the source VideoFrame immediately or Chromium will
            // stall the WebRTC decoder pool after ~16 leaked frames.
            frame.close();
          }
        }
      });

      const pipeOpts = this._abortController ? { signal: this._abortController.signal } : undefined;
      processor.readable
        .pipeThrough(transformer, pipeOpts)
        .pipeTo(generator.writable, pipeOpts)
        .catch(() => {
          // Stream ended or aborted during reset/teardown.
        });

      this.outputStream = new MediaStream([generator, ...audioTracks]);
      CROPPED_STREAMS.add(this.outputStream);
      this.mode = "webcodecs";
      return this.outputStream;
    }

    _startCanvasFallback(audioTracks) {
      const hiddenVideo = document.createElement("video");
      hiddenVideo.dataset.dscInternal = "true";
      hiddenVideo.muted = true;
      hiddenVideo.autoplay = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = this.sourceStream;
      if (typeof hiddenVideo.play === "function") {
        const p = hiddenVideo.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }

      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext && canvas.getContext("2d", { alpha: false });

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
          this.lastOutputSize = { width: rect.width, height: rect.height };
          try {
            ctx.drawImage(hiddenVideo, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
          } catch (_err) {
            // Source video hasn't decoded a frame yet.
          }
        }
        if (typeof requestAnimationFrame === "function") {
          this._rafId = requestAnimationFrame(drawTick);
        }
      };

      drawTick();

      const stream = canvas.captureStream ? canvas.captureStream(60) : new MediaStream();
      for (const audioTrack of audioTracks) {
        if (stream.addTrack) stream.addTrack(audioTrack);
      }
      CROPPED_STREAMS.add(stream);

      this._hiddenVideo = hiddenVideo;
      this._canvas = canvas;
      this.outputStream = stream;
      this.mode = "canvas";
      return this.outputStream;
    }

    stop() {
      if (this.disposed) return;
      this.disposed = true;

      if (this._abortController) {
        try {
          this._abortController.abort();
        } catch (_e) {}
        this._abortController = null;
      }

      if (this._generator) {
        try {
          if (typeof this._generator.stop === "function") this._generator.stop();
        } catch (_e) {}
        this._generator = null;
      }

      if (this._rafId && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }

      if (this._hiddenVideo) {
        try {
          if (typeof this._hiddenVideo.pause === "function") this._hiddenVideo.pause();
          this._hiddenVideo.srcObject = null;
        } catch (_e) {}
        this._hiddenVideo = null;
      }

      // Only stop our synthetic canvas video tracks — stopping shared audio tracks
      // would mute the streamer's audio on Discord's original stream too.
      if (this.outputStream && this.mode === "canvas" && this.outputStream.getVideoTracks) {
        for (const track of this.outputStream.getVideoTracks()) {
          if (typeof track.stop === "function") track.stop();
        }
      }

      this._canvas = null;
      this.outputStream = null;
    }
  }

  // Owns persisted settings, saved crop presets, and per-streamer crop recall.
  // Sanitizes external storage once on load so the rest of the plugin can trust it.
  class CropStore {
    #dataApi;
    #sessionMemory = new Map();

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
              region: normalizeRegion(item.region),
              preset: typeof item.preset === "string" ? item.preset : "custom",
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

    rememberStream(identities, region, preset = "custom") {
      if (!this.settings.rememberPerStreamer || !identities) return;

      const isFull = isFullRegion(region);
      const record = isFull
        ? null
        : { region: normalizeRegion(region), preset, updatedAt: Date.now() };

      for (const sessionKey of identities.sessionKeys) {
        if (isFull) this.#sessionMemory.delete(sessionKey);
        else this.#sessionMemory.set(sessionKey, record);
      }

      let dirty = false;
      for (const key of identities.persistentKeys) {
        const idx = this.rememberedCrops.findIndex((item) => item.key === key);
        if (isFull) {
          if (idx >= 0) {
            this.rememberedCrops.splice(idx, 1);
            dirty = true;
          }
          continue;
        }
        if (idx >= 0) this.rememberedCrops.splice(idx, 1);
        this.rememberedCrops.push({ key, ...record });
        if (this.rememberedCrops.length > MAX_REMEMBERED_STREAMS) {
          this.rememberedCrops.shift();
        }
        dirty = true;
      }

      if (dirty) this.save();
    }

    recallStream(identities) {
      if (!this.settings.rememberPerStreamer || !identities) return null;

      for (const sessionKey of identities.sessionKeys) {
        const hit = this.#sessionMemory.get(sessionKey);
        if (hit) return hit;
      }

      for (const key of identities.persistentKeys) {
        for (let i = this.rememberedCrops.length - 1; i >= 0; i--) {
          if (this.rememberedCrops[i].key === key) return this.rememberedCrops[i];
        }
      }

      return null;
    }

    clearSession() {
      this.#sessionMemory.clear();
    }
  }

  class StreamCropper {
    #listeners = null;
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
            UI: BdApi.UI
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

      this.api.DOM.addStyle(STYLES);
      this.scan();

      this.#listeners = new AbortController();
      const { signal } = this.#listeners;

      const onOutsidePointer = (event) => {
        for (const controller of this.controllers.values()) {
          controller.handleOutsidePointer(event);
        }
      };

      document.addEventListener("pointerdown", onOutsidePointer, { capture: true, signal });
      document.addEventListener("mousedown", onOutsidePointer, { capture: true, signal });
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.key !== "Escape") return;
          for (const controller of this.controllers.values()) {
            if (controller.isDrawing) {
              event.stopPropagation();
              event.preventDefault();
              controller.closeDrawModal();
            } else if (controller.isOpen) {
              controller.closeHud();
            }
          }
        },
        { capture: true, signal }
      );

      // Discord assigns `video.srcObject` asynchronously after mounting `<video>`,
      // which does not emit a DOM mutation record.
      this.#rescanInterval = setInterval(() => {
        if (this.running) this.scan();
      }, 1500);
    }

    observer(mutation) {
      if (!this.running) return;
      if (mutation?.addedNodes?.length || mutation?.removedNodes?.length) {
        this.scheduleScan();
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
            controller.syncUI();
          }
        }
      });
    }

    showToast(message, type = "info") {
      this.api.UI?.showToast?.(message, { type });
    }

    attachTooltip(node, text) {
      if (!node) return null;
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

    rememberStreamCrop(identities, region, preset) {
      this.store.rememberStream(identities, region, preset);
    }

    recallStreamCrop(identities) {
      return this.store.recallStream(identities);
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

    isEligibleStreamVideo(video) {
      if (!video || video.nodeName !== "VIDEO" || !video.isConnected) return false;
      if (video.dataset.dscInternal === "true") return false;
      if (!(video.srcObject instanceof MediaStream)) return false;

      const rect = video.getBoundingClientRect();
      const width = video.clientWidth || rect.width;
      const height = video.clientHeight || rect.height;

      return width > MIN_STAGE_VIDEO_WIDTH && height > MIN_STAGE_VIDEO_HEIGHT;
    }

    scan() {
      if (!this.running) return;

      for (const [video, controller] of this.controllers) {
        if (!video.isConnected || !this.isEligibleStreamVideo(video)) {
          controller.destroy();
          this.controllers.delete(video);
        } else {
          controller.ensureMounted();
        }
      }

      for (const video of document.querySelectorAll("video")) {
        if (!this.controllers.has(video) && this.isEligibleStreamVideo(video)) {
          const controller = new VideoSourceController(video, this);
          controller.mount();
          this.controllers.set(video, controller);
        }
      }
    }
  }

  class VideoSourceController {
    constructor(video, manager) {
      this.video = video;
      this.manager = manager;

      this.originalStream = video.srcObject;
      this._nativeSrcDesc = null;
      this.cropSession = null;

      // Secondary muted <video> attached to the uncropped `originalStream` so our
      // minimap and Draw Custom Region modal still show the full monitor even
      // after `this.video.srcObject` has been swapped to the cropped stream.
      this.sourceMonitorVideo = null;

      this.region = { ...FULL_REGION };
      this.activePreset = "full";
      this.isOpen = false;
      this.isDrawing = false;
      this._didAutoCrop = false;

      this.host = null;
      this.promotedHostPos = false;
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
      this.drawModalRaf = null;
      this._tooltips = [];
      this._presetBtns = new Map();

      this._minimapRaf = null;
      this._lastMinimapTs = 0;
      this._hoverTimer = null;

      this._onHostEnter = () => this._setHover(true);
      this._onHostMove = () => this._bumpHover();
      this._onHostLeave = () => this._setHover(false);
      this._onVideoResize = () => this._handleStreamMetadata();
    }

    // Climb out of the inner `<video>` flex box so the `Crop` button sits in the
    // top corner of the full stream stage, but stop before climbing into the outer
    // call container that also wraps the participant avatar row at the bottom.
    _resolveHostContainer() {
      const immediate = this.video.parentElement;
      if (!immediate) return null;

      let best = immediate;
      let cur = immediate;

      for (let depth = 0; depth < 8 && cur && cur !== document.body && cur !== document.documentElement; depth++) {
        if (cur.querySelectorAll && cur.querySelectorAll("video").length > 1) {
          break;
        }

        if (cur !== immediate && cur.children && cur.children.length > 1) {
          let hasParticipantRow = false;
          for (const child of cur.children) {
            if (child.contains && child.contains(this.video)) continue;
            const cr = child.getBoundingClientRect ? child.getBoundingClientRect() : null;
            const cw = child.clientWidth || (cr ? cr.width : 0);
            const ch = child.clientHeight || (cr ? cr.height : 0);
            if (cw > 300 && ch >= 95) {
              hasParticipantRow = true;
              break;
            }
          }
          if (hasParticipantRow) break;
        }

        const rect = cur.getBoundingClientRect ? cur.getBoundingClientRect() : null;
        const w = cur.clientWidth || (rect ? rect.width : 0);
        const h = cur.clientHeight || (rect ? rect.height : 0);
        if (w >= MIN_STAGE_VIDEO_WIDTH && h >= MIN_STAGE_VIDEO_HEIGHT) {
          best = cur;
        }

        cur = cur.parentElement;
      }

      return best;
    }

    mount() {
      const host = this._resolveHostContainer();
      if (!host) return;
      this.host = host;

      const computed = typeof window.getComputedStyle === "function" ? window.getComputedStyle(host) : null;
      const pos = computed ? computed.position : host.style.position;
      if (!pos || pos === "static") {
        host.classList.add("dsc-host-positioned");
        this.promotedHostPos = true;
      }

      this._installVideoSrcHook();
      this._buildUI();
      host.appendChild(this.rootEl);

      // If React purges custom child nodes inside `host` while keeping the stream
      // alive, re-append our overlay immediately via BetterDiscord's DOM helper.
      this._offRemoved = null;
      this._watchOverlayRemoval();

      host.addEventListener("mouseenter", this._onHostEnter);
      host.addEventListener("mousemove", this._onHostMove, { passive: true });
      host.addEventListener("mouseleave", this._onHostLeave);
      this.video.addEventListener("loadedmetadata", this._onVideoResize);
      this.video.addEventListener("resize", this._onVideoResize);

      this._handleStreamMetadata();
      this.syncUI();
    }

    _setNativeSrcObject(stream) {
      if (this._nativeSrcDesc && typeof this._nativeSrcDesc.set === "function") {
        this._nativeSrcDesc.set.call(this.video, stream);
      } else {
        this.video.srcObject = stream;
      }
    }

    _getNativeSrcObject() {
      if (this._nativeSrcDesc && typeof this._nativeSrcDesc.get === "function") {
        return this._nativeSrcDesc.get.call(this.video);
      }
      return this.video.srcObject;
    }

    // Discord's React tree periodically re-renders the player and re-runs
    // `video.srcObject = originalStream`. We shadow `srcObject` on this single
    // `<video>` instance (never on HTMLMediaElement.prototype) so React re-renders
    // don't clobber an active crop, while genuine stream switches are caught cleanly.
    _installVideoSrcHook() {
      this._removeVideoSrcHook();

      let desc = null;
      let proto = Object.getPrototypeOf(this.video);
      while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, "srcObject");
        proto = Object.getPrototypeOf(proto);
      }
      if (!desc || typeof desc.get !== "function" || typeof desc.set !== "function") {
        return;
      }

      this._nativeSrcDesc = desc;
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
            controller._teardownCropSession(false);
            controller.originalStream = null;
            desc.set.call(this, null);
            return;
          }

          // React re-assigned the exact same stream we're already cropping — keep our cropped output alive.
          if (controller.originalStream && incomingStream === controller.originalStream) {
            if (controller.cropSession && controller.cropSession.outputStream) {
              desc.set.call(this, controller.cropSession.outputStream);
              return;
            }
            desc.set.call(this, incomingStream);
            return;
          }

          // User switched to watching a different stream on the same `<video>` element.
          controller.originalStream = incomingStream;
          controller._didAutoCrop = false;
          if (controller.sourceMonitorVideo) {
            controller.sourceMonitorVideo.srcObject = incomingStream;
          }

          const recalled = controller.manager.recallStreamCrop(controller._getStreamIdentities());
          if (recalled && recalled.region && !isFullRegion(recalled.region)) {
            controller.region = normalizeRegion(recalled.region);
            controller.activePreset = recalled.preset || "custom";
            controller._didAutoCrop = true;
            controller._rebuildCropSession();
            controller.syncUI();
            return;
          }

          // Don't carry someone's ultrawide crop over onto a different streamer's 16:9 feed.
          controller._teardownCropSession(false);
          controller.region = { ...FULL_REGION };
          controller.activePreset = "full";
          desc.set.call(this, incomingStream);
          controller._handleStreamMetadata();
          controller.syncUI();
        }
      });
    }

    _removeVideoSrcHook() {
      if (!this._nativeSrcDesc) return;
      try {
        delete this.video.srcObject;
      } catch (_e) {}
      this._nativeSrcDesc = null;
    }

    ensureMounted() {
      if (!this.host || !this.host.isConnected) return;
      if (this.rootEl && !this.rootEl.isConnected) {
        this.host.appendChild(this.rootEl);
      }

      const current = this._getNativeSrcObject();
      if (current && !CROPPED_STREAMS.has(current) && current !== this.originalStream) {
        this.originalStream = current;
        this._didAutoCrop = false;
        if (this.sourceMonitorVideo) {
          this.sourceMonitorVideo.srcObject = current;
        }
        const recalled = this.manager.recallStreamCrop(this._getStreamIdentities());
        if (recalled && recalled.region && !isFullRegion(recalled.region)) {
          this.region = normalizeRegion(recalled.region);
          this.activePreset = recalled.preset || "custom";
          this._didAutoCrop = true;
          this._rebuildCropSession();
          this.syncUI();
          return;
        }
        this._teardownCropSession(false);
        this.region = { ...FULL_REGION };
        this.activePreset = "full";
        this._handleStreamMetadata();
        this.syncUI();
      }
    }

    _watchOverlayRemoval() {
      if (this._offRemoved) {
        try {
          this._offRemoved();
        } catch (_e) {}
        this._offRemoved = null;
      }
      if (!this.rootEl || typeof BdApi === "undefined" || !BdApi.DOM || typeof BdApi.DOM.onRemoved !== "function") {
        return;
      }
      this._offRemoved = BdApi.DOM.onRemoved(this.rootEl, () => {
        if (this.host && this.host.isConnected && this.video.isConnected && this.rootEl) {
          this.host.appendChild(this.rootEl);
          this._watchOverlayRemoval();
        }
      });
    }

    destroy() {
      this.closeDrawModal();
      this._stopMinimapLoop();

      if (this._offRemoved) {
        try {
          this._offRemoved();
        } catch (_e) {}
        this._offRemoved = null;
      }

      if (this._hoverTimer) {
        clearTimeout(this._hoverTimer);
        this._hoverTimer = null;
      }

      this._removeVideoSrcHook();
      this._teardownCropSession(true);
      this._destroySourceMonitor();

      if (this.host) {
        this.host.removeEventListener("mouseenter", this._onHostEnter);
        this.host.removeEventListener("mousemove", this._onHostMove);
        this.host.removeEventListener("mouseleave", this._onHostLeave);
        this.host.classList.remove("dsc-host-hover");
        if (this.promotedHostPos) {
          this.host.classList.remove("dsc-host-positioned");
          this.promotedHostPos = false;
        }
      }

      this.video.removeEventListener("loadedmetadata", this._onVideoResize);
      this.video.removeEventListener("resize", this._onVideoResize);

      if (this._tooltips.length) {
        for (const tip of this._tooltips) {
          try {
            if (tip && typeof tip.destroy === "function") tip.destroy();
            else if (tip && typeof tip.hide === "function") tip.hide();
          } catch (_e) {}
        }
        this._tooltips = [];
      }

      if (this.rootEl) {
        this.rootEl.remove();
        this.rootEl = null;
      }
      this.host = null;
    }

    // Grab the streamer's display name from Discord's overlay badge without relying
    // on hashed Discord class names that break on client updates.
    _extractStreamerLabel() {
      if (!this.host || !this.host.querySelectorAll) return "";
      const nodes = this.host.querySelectorAll("span, div");
      for (const el of nodes) {
        if (this.rootEl && this.rootEl.contains(el)) continue;
        if (el.children && el.children.length > 0) continue;
        const text = String(el.textContent || "").trim();
        if (
          text.length >= 2 &&
          text.length <= 32 &&
          !/^(LIVE|HD|FHD|QHD|4K|1080p|720p|1440p|60|30|FPS|\d+[:x×]\d+)$/i.test(text)
        ) {
          return text.toLowerCase();
        }
      }
      return "";
    }

    // Build lookup keys from most specific (live WebRTC stream/track IDs) to
    // durable across reconnects (streamer badge + resolution, or ultrawide resolution).
    _getStreamIdentities() {
      const sessionKeys = [];
      const persistentKeys = [];

      if (this.originalStream) {
        if (typeof this.originalStream.id === "string" && this.originalStream.id) {
          sessionKeys.push(`stream:${this.originalStream.id}`);
        }
        const vTracks = this.originalStream.getVideoTracks ? this.originalStream.getVideoTracks() : [];
        if (vTracks.length && typeof vTracks[0].id === "string" && vTracks[0].id) {
          sessionKeys.push(`track:${vTracks[0].id}`);
        }
      }

      const dims = this._getOriginalDimensions();
      const hasDims = dims.width > 0 && dims.height > 0;
      const streamer = this._extractStreamerLabel();

      if (streamer && hasDims) {
        persistentKeys.push(`streamer:${streamer}|${dims.width}x${dims.height}`);
      }
      if (streamer) {
        persistentKeys.push(`streamer:${streamer}`);
      }
      if (hasDims && dims.width / Math.max(1, dims.height) > 2.05) {
        persistentKeys.push(`ultrawide-res:${dims.width}x${dims.height}`);
      }

      return { sessionKeys, persistentKeys };
    }

    _handleStreamMetadata() {
      const dims = this._getOriginalDimensions();
      const aspect = dims.width / Math.max(1, dims.height);

      if (!this._didAutoCrop && isFullRegion(this.region)) {
        const recalled = this.manager.recallStreamCrop(this._getStreamIdentities());
        if (recalled && recalled.region && !isFullRegion(recalled.region)) {
          this._didAutoCrop = true;
          this.region = normalizeRegion(recalled.region);
          this.activePreset = recalled.preset || "custom";
          this._applySourceCrop();
          this.syncUI();
          return;
        }
      }

      if (
        !this._didAutoCrop &&
        this.manager.settings.autoCenterUltrawide &&
        isFullRegion(this.region) &&
        dims.width > 0 &&
        aspect > 2.15
      ) {
        this._didAutoCrop = true;
        this.applyPreset("center");
        return;
      }

      this.syncUI();
    }

    _setHover(hovered) {
      if (!this.host) return;
      if (hovered) {
        this.host.classList.add("dsc-host-hover");
        this._bumpHover();
      } else {
        if (this._hoverTimer) {
          clearTimeout(this._hoverTimer);
          this._hoverTimer = null;
        }
        this.host.classList.remove("dsc-host-hover");
      }
    }

    _bumpHover() {
      if (!this.host) return;
      this.host.classList.add("dsc-host-hover");
      if (this._hoverTimer) clearTimeout(this._hoverTimer);
      this._hoverTimer = setTimeout(() => {
        if (this.host && !this.isOpen) {
          this.host.classList.remove("dsc-host-hover");
        }
      }, 2200);
    }

    // Stop clicks, double-clicks, drags, and wheel events on our UI from bubbling
    // into Discord's player (where double-click toggles fullscreen).
    _shieldEvents(el) {
      const events = ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu", "wheel"];
      for (const evt of events) {
        el.addEventListener(
          evt,
          (e) => {
            e.stopPropagation();
            if (evt === "dblclick") e.preventDefault();
          },
          evt === "wheel" ? { passive: false } : false
        );
      }
    }

    _getOriginalDimensions() {
      if (this.sourceMonitorVideo && this.sourceMonitorVideo.videoWidth > 0 && this.sourceMonitorVideo.videoHeight > 0) {
        return {
          width: this.sourceMonitorVideo.videoWidth,
          height: this.sourceMonitorVideo.videoHeight
        };
      }

      const vTracks =
        this.originalStream && this.originalStream.getVideoTracks
          ? this.originalStream.getVideoTracks()
          : [];
      if (vTracks.length && typeof vTracks[0].getSettings === "function") {
        const settings = vTracks[0].getSettings();
        if (settings && settings.width > 0 && settings.height > 0) {
          return { width: settings.width, height: settings.height };
        }
      }

      if (isFullRegion(this.region) && this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        return { width: this.video.videoWidth, height: this.video.videoHeight };
      }

      return {
        width: this.video.videoWidth || this.video.clientWidth || 1920,
        height: this.video.videoHeight || this.video.clientHeight || 1080
      };
    }

    _ensureSourceMonitor() {
      if (this.sourceMonitorVideo) {
        if (this.originalStream && this.sourceMonitorVideo.srcObject !== this.originalStream) {
          this.sourceMonitorVideo.srcObject = this.originalStream;
        }
        return this.sourceMonitorVideo;
      }

      const monitor = document.createElement("video");
      monitor.dataset.dscInternal = "true";
      monitor.muted = true;
      monitor.autoplay = true;
      monitor.playsInline = true;
      if (this.originalStream) {
        monitor.srcObject = this.originalStream;
      }
      if (typeof monitor.play === "function") {
        const p = monitor.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
      this.sourceMonitorVideo = monitor;
      return monitor;
    }

    _destroySourceMonitor() {
      if (!this.sourceMonitorVideo) return;
      try {
        if (typeof this.sourceMonitorVideo.pause === "function") this.sourceMonitorVideo.pause();
        this.sourceMonitorVideo.srcObject = null;
      } catch (_e) {}
      this.sourceMonitorVideo = null;
    }

    _applySourceCrop() {
      if (isFullRegion(this.region)) {
        this._teardownCropSession(true);
        return;
      }

      if (!this.originalStream) {
        const cur = this._getNativeSrcObject();
        if (cur && !CROPPED_STREAMS.has(cur)) {
          this.originalStream = cur;
        }
      }
      if (!this.originalStream) return;

      this._ensureSourceMonitor();

      if (this.cropSession && !this.cropSession.disposed && this.cropSession.sourceStream === this.originalStream) {
        this.cropSession.setRegion(this.region);
        return;
      }

      this._rebuildCropSession();
    }

    _rebuildCropSession() {
      if (this.cropSession) {
        this.cropSession.stop();
        this.cropSession = null;
      }
      if (!this.originalStream || isFullRegion(this.region)) return;

      this._ensureSourceMonitor();
      const session = new MediaStreamCropSession(this.originalStream, this.region);
      const croppedStream = session.start();
      if (!croppedStream) return;

      this.cropSession = session;
      this._setNativeSrcObject(croppedStream);
      if (typeof this.video.play === "function") {
        const p = this.video.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    }

    _teardownCropSession(restoreOriginal) {
      const hadSession = Boolean(this.cropSession);
      if (this.cropSession) {
        this.cropSession.stop();
        this.cropSession = null;
      }
      if (restoreOriginal && hadSession && this.originalStream && this.video.isConnected) {
        this._setNativeSrcObject(this.originalStream);
        if (typeof this.video.play === "function") {
          const p = this.video.play();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      }
    }

    _buildUI() {
      const root = document.createElement("div");
      root.className = "dsc-root";

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "dsc-trigger";
      const triggerTip = this.manager.attachTooltip(trigger, "Crop stream source");
      if (triggerTip) this._tooltips.push(triggerTip);
      trigger.innerHTML = `${ICONS.crop}<span>Crop</span>`;

      const resSpan = document.createElement("span");
      resSpan.className = "dsc-trigger-res";
      const dotSpan = document.createElement("span");
      dotSpan.className = "dsc-dot";
      trigger.appendChild(resSpan);
      trigger.appendChild(dotSpan);

      this._shieldEvents(trigger);
      trigger.addEventListener("click", (e) => {
        e.preventDefault();
        this.toggleHud();
      });

      const hud = document.createElement("div");
      hud.className = "dsc-hud";
      this._shieldEvents(hud);

      const header = document.createElement("div");
      header.className = "dsc-header";

      const titleWrap = document.createElement("div");
      titleWrap.className = "dsc-title-wrap";

      const title = document.createElement("span");
      title.className = "dsc-title";
      title.textContent = "Source Crop";

      const meta = document.createElement("span");
      meta.className = "dsc-meta";
      meta.textContent = "Full Stream";

      titleWrap.appendChild(title);
      titleWrap.appendChild(meta);

      const headerBtns = document.createElement("div");
      headerBtns.className = "dsc-header-btns";

      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "dsc-icon-btn dsc-reset-btn";
      resetBtn.title = "Restore uncropped stream";
      resetBtn.innerHTML = `${ICONS.reset}<span>Reset</span>`;
      resetBtn.addEventListener("click", () => this.reset());

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "dsc-icon-btn";
      closeBtn.title = "Close panel";
      closeBtn.innerHTML = ICONS.close;
      closeBtn.addEventListener("click", () => this.closeHud());

      headerBtns.appendChild(resetBtn);
      headerBtns.appendChild(closeBtn);
      header.appendChild(titleWrap);
      header.appendChild(headerBtns);
      hud.appendChild(header);

      const chips = document.createElement("div");
      chips.className = "dsc-chips";
      const presets = [
        { id: "full", label: "Full", title: "Original uncropped stream" },
        { id: "left", label: "Left", title: "Left monitor / slice" },
        { id: "center", label: "Center", title: "Center monitor / slice" },
        { id: "right", label: "Right", title: "Right monitor / slice" },
        { id: "21:9", label: "21:9", title: "Center 21:9 crop" }
      ];
      for (const preset of presets) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dsc-chip";
        btn.dataset.preset = preset.id;
        btn.textContent = preset.label;
        btn.title = preset.title;
        btn.addEventListener("click", () => this.applyPreset(preset.id));
        this._presetBtns.set(preset.id, btn);
        chips.appendChild(btn);
      }
      hud.appendChild(chips);

      const minimap = document.createElement("div");
      minimap.className = "dsc-minimap";
      minimap.title = "Drag box to pan, drag handles to resize, or double-click to reset";

      const mmCanvas = document.createElement("canvas");
      mmCanvas.className = "dsc-minimap-canvas";
      mmCanvas.width = 320;
      mmCanvas.height = 180;

      const box = document.createElement("div");
      box.className = "dsc-minimap-box";
      for (const dir of ["nw", "ne", "sw", "se", "n", "s", "w", "e"]) {
        const handle = document.createElement("div");
        handle.className = `dsc-handle dsc-handle-${dir}`;
        handle.dataset.handle = dir;
        box.appendChild(handle);
      }

      minimap.appendChild(mmCanvas);
      minimap.appendChild(box);
      this._attachMinimapHandlers(minimap, box);
      hud.appendChild(minimap);

      const footer = document.createElement("div");
      footer.className = "dsc-footer";

      const drawBtn = document.createElement("button");
      drawBtn.type = "button";
      drawBtn.className = "dsc-icon-btn dsc-draw-full-btn";
      drawBtn.title = "Draw a custom crop box on the full uncropped frame";
      drawBtn.innerHTML = `${ICONS.draw}<span>Draw Custom Region</span>`;
      drawBtn.addEventListener("click", () => this.openDrawModal());

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "dsc-icon-btn dsc-save-btn";
      saveBtn.title = "Save current crop preset";
      saveBtn.innerHTML = `${ICONS.bookmark}<span>Save</span>`;
      saveBtn.addEventListener("click", () => {
        if (isFullRegion(this.region)) {
          this.manager.showToast("Select a crop area before saving a preset", "warning");
          return;
        }
        const count = this.manager.savedPresets.length;
        const label =
          this.activePreset !== "custom" && this.activePreset !== "full"
            ? this.activePreset.toUpperCase()
            : `Crop ${count + 1}`;
        this.manager.savePreset(label, this.region);
        this.manager.showToast(`Saved "${label}"`, "success");
      });

      footer.appendChild(drawBtn);
      footer.appendChild(saveBtn);
      hud.appendChild(footer);

      const savedRow = document.createElement("div");
      savedRow.className = "dsc-saved-row";
      hud.appendChild(savedRow);

      root.appendChild(trigger);
      root.appendChild(hud);

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
    }

    _attachMinimapHandlers(minimap, box) {
      minimap.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.reset();
      });

      minimap.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          const factor = e.deltaY < 0 ? 0.9 : 1.1;
          const cx = this.region.x + this.region.w / 2;
          const cy = this.region.y + this.region.h / 2;
          let baseW = this.region.w;
          let baseH = this.region.h;

          if (isFullRegion(this.region) && e.deltaY < 0) {
            const dims = this._getOriginalDimensions();
            const aspect = dims.width / Math.max(1, dims.height);
            const target = ASPECT_RATIOS[this.manager.settings.defaultSliceAspect] || 16 / 9;
            baseW = aspect > target ? clamp(target / aspect, 0.25, 0.9) : 0.85;
            baseH = aspect > target ? 0.9 : 0.85;
          }

          const nw = clamp(baseW * factor, MIN_CROP_FRACTION, 1);
          const nh = clamp(baseH * factor, MIN_CROP_FRACTION, 1);
          if (nw >= 0.995 && nh >= 0.995) {
            this.reset();
            return;
          }
          this.activePreset = "custom";
          this.setRegion({ x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh });
        },
        { passive: false }
      );

      minimap.addEventListener("mousedown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = minimap.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const handleDir = e.target && e.target.dataset ? e.target.dataset.handle : null;
        const insideBox = box.contains(e.target) && !handleDir;

        const startX = e.clientX;
        const startY = e.clientY;
        const startReg = { ...this.region };

        let mode = "create";
        if (handleDir) {
          mode = `resize-${handleDir}`;
        } else if (insideBox && !isFullRegion(this.region)) {
          mode = "move";
        }

        const originX = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        const originY = clamp((e.clientY - rect.top) / rect.height, 0, 1);

        const onMove = (me) => {
          me.preventDefault();
          me.stopPropagation();

          const dx = (me.clientX - startX) / rect.width;
          const dy = (me.clientY - startY) / rect.height;

          if (mode === "move") {
            this.activePreset = "custom";
            this.setRegion({
              x: clamp(startReg.x + dx, 0, 1 - startReg.w),
              y: clamp(startReg.y + dy, 0, 1 - startReg.h),
              w: startReg.w,
              h: startReg.h
            });
            return;
          }

          if (mode === "create") {
            const curX = clamp((me.clientX - rect.left) / rect.width, 0, 1);
            const curY = clamp((me.clientY - rect.top) / rect.height, 0, 1);
            const w = Math.abs(curX - originX);
            const h = Math.abs(curY - originY);
            if (w < 0.03 && h < 0.03) return;
            this.activePreset = "custom";
            this.setRegion({
              x: Math.min(originX, curX),
              y: Math.min(originY, curY),
              w: Math.max(MIN_CROP_FRACTION, w),
              h: Math.max(MIN_CROP_FRACTION, h)
            });
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

          this.activePreset = "custom";
          this.setRegion({
            x: left,
            y: top,
            w: right - left,
            h: bottom - top
          });
        };

        const onUp = (ue) => {
          ue.preventDefault();
          ue.stopPropagation();
          window.removeEventListener("mousemove", onMove, true);
          window.removeEventListener("mouseup", onUp, true);
        };

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
      });
    }

    _updateMinimapSize() {
      if (!this.minimapEl || !this.minimapCanvas) return;
      const dims = this._getOriginalDimensions();
      const aspect = clamp(dims.width / Math.max(1, dims.height), 0.75, 4.2);
      const w = 312;
      const h = Math.round(clamp(w / aspect, 78, 176));
      this.minimapEl.style.height = `${h}px`;
      if (this.minimapCanvas.width !== w * 2 || this.minimapCanvas.height !== h * 2) {
        this.minimapCanvas.width = w * 2;
        this.minimapCanvas.height = h * 2;
      }
    }

    _startMinimapLoop() {
      this._stopMinimapLoop();
      this._ensureSourceMonitor();

      if (typeof requestAnimationFrame === "undefined") {
        this._drawMinimap();
        return;
      }

      const tick = (ts) => {
        if (!this.isOpen) return;
        if (ts - this._lastMinimapTs >= 75) {
          this._lastMinimapTs = ts;
          this._drawMinimap();
        }
        this._minimapRaf = requestAnimationFrame(tick);
      };
      this._drawMinimap();
      this._minimapRaf = requestAnimationFrame(tick);
    }

    _stopMinimapLoop() {
      if (this._minimapRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this._minimapRaf);
      }
      this._minimapRaf = null;
    }

    _drawMinimap() {
      if (!this.minimapCanvas) return;
      this._updateMinimapSize();
      const srcVideo = isFullRegion(this.region)
        ? this.video
        : this._ensureSourceMonitor();
      try {
        const ctx = this.minimapCanvas.getContext && this.minimapCanvas.getContext("2d");
        if (ctx) ctx.drawImage(srcVideo, 0, 0, this.minimapCanvas.width, this.minimapCanvas.height);
      } catch (_e) {}
    }

    // Opens a large view of the uncropped monitor so you can drag a box around a
    // specific game window or editor pane even while the stream is already cropped.
    openDrawModal() {
      if (this.isDrawing) return;
      this.isDrawing = true;
      this.closeHud();

      const monitor = isFullRegion(this.region) ? this.video : this._ensureSourceMonitor();
      const dims = this._getOriginalDimensions();
      const aspect = clamp(dims.width / Math.max(1, dims.height), 0.5, 5);

      const maxW = Math.min(window.innerWidth * 0.9, 1400);
      const maxH = Math.min(window.innerHeight * 0.78, 820);
      let stageW = maxW;
      let stageH = stageW / aspect;
      if (stageH > maxH) {
        stageH = maxH;
        stageW = stageH * aspect;
      }
      stageW = Math.max(240, Math.round(stageW));
      stageH = Math.max(140, Math.round(stageH));

      const modal = document.createElement("div");
      modal.className = "dsc-draw-modal";
      this._shieldEvents(modal);

      const bar = document.createElement("div");
      bar.className = "dsc-draw-modal-bar";
      bar.innerHTML = `<span>Drag across the part of the ${dims.width}×${dims.height} stream you want to watch</span>`;

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "dsc-icon-btn";
      cancelBtn.textContent = "Cancel (Esc)";
      cancelBtn.addEventListener("click", () => this.closeDrawModal());
      bar.appendChild(cancelBtn);

      const stage = document.createElement("div");
      stage.className = "dsc-draw-stage";
      stage.style.width = `${stageW}px`;
      stage.style.height = `${stageH}px`;

      const canvas = document.createElement("canvas");
      canvas.className = "dsc-draw-stage-canvas";
      canvas.width = stageW * 2;
      canvas.height = stageH * 2;
      canvas.style.width = `${stageW}px`;
      canvas.style.height = `${stageH}px`;

      const selBox = document.createElement("div");
      selBox.className = "dsc-draw-selection";

      const readout = document.createElement("div");
      readout.className = "dsc-draw-readout";
      selBox.appendChild(readout);

      stage.appendChild(canvas);
      stage.appendChild(selBox);
      modal.appendChild(bar);
      modal.appendChild(stage);

      const drawPreview = () => {
        if (!this.isDrawing) return;
        try {
          const ctx = canvas.getContext && canvas.getContext("2d");
          if (ctx) ctx.drawImage(monitor, 0, 0, canvas.width, canvas.height);
        } catch (_e) {}
        if (typeof requestAnimationFrame === "function") {
          this.drawModalRaf = requestAnimationFrame(drawPreview);
        }
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

      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        e.preventDefault();
        e.stopPropagation();

        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);

        const bounds = stage.getBoundingClientRect();
        const ex = clamp(e.clientX - bounds.left, 0, bounds.width);
        const ey = clamp(e.clientY - bounds.top, 0, bounds.height);
        const x1 = Math.min(startX, ex);
        const y1 = Math.min(startY, ey);
        const w = Math.abs(ex - startX);
        const h = Math.abs(ey - startY);

        this.closeDrawModal();

        // Ignore accidental clicks without a real drag.
        if (w < 14 || h < 14 || bounds.width <= 0 || bounds.height <= 0) {
          return;
        }

        this.activePreset = "custom";
        this.setRegion({
          x: x1 / bounds.width,
          y: y1 / bounds.height,
          w: w / bounds.width,
          h: h / bounds.height
        });
      };

      this._cleanupModalDrag = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
      };

      stage.addEventListener("mousedown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const bounds = stage.getBoundingClientRect();
        startX = clamp(e.clientX - bounds.left, 0, bounds.width);
        startY = clamp(e.clientY - bounds.top, 0, bounds.height);
        dragging = true;
        selBox.style.display = "block";
        selBox.style.left = `${startX}px`;
        selBox.style.top = `${startY}px`;
        selBox.style.width = "1px";
        selBox.style.height = "1px";

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("mouseup", onUp, true);
      });

      modal.addEventListener("click", (e) => {
        if (e.target === modal) this.closeDrawModal();
      });

      document.body.appendChild(modal);
      this.drawModalEl = modal;
      drawPreview();
    }

    closeDrawModal() {
      if (!this.isDrawing && !this.drawModalEl) return;
      this.isDrawing = false;
      if (this.drawModalRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.drawModalRaf);
        this.drawModalRaf = null;
      }
      if (this._cleanupModalDrag) {
        this._cleanupModalDrag();
        this._cleanupModalDrag = null;
      }
      if (this.drawModalEl) {
        this.drawModalEl.remove();
        this.drawModalEl = null;
      }
    }

    toggleHud() {
      if (this.isOpen) this.closeHud();
      else this.openHud();
    }

    openHud() {
      this.isOpen = true;
      if (this.rootEl) this.rootEl.classList.add("dsc-open");
      this._updateMinimapSize();
      this.renderSavedPresets();
      this.syncUI();
      this._startMinimapLoop();
    }

    closeHud() {
      this.isOpen = false;
      this._stopMinimapLoop();
      if (this.rootEl) this.rootEl.classList.remove("dsc-open");
    }

    handleOutsidePointer(event) {
      if (!this.isOpen) return;
      const target = event.target;
      if (this.rootEl && target && this.rootEl.contains(target)) return;
      if (this.drawModalEl && target && this.drawModalEl.contains(target)) return;
      this.closeHud();
    }

    setRegion(nextRegion, persist = true) {
      this.region = normalizeRegion(nextRegion);
      if (isFullRegion(this.region)) {
        this.activePreset = "full";
      }
      this._applySourceCrop();
      if (persist) {
        this.manager.rememberStreamCrop(this._getStreamIdentities(), this.region, this.activePreset);
      }
      this.syncUI();
    }

    applyPreset(presetId, persist = true) {
      if (presetId === "full") {
        this.reset(persist);
        return;
      }
      const dims = this._getOriginalDimensions();
      const aspect = dims.width / Math.max(1, dims.height);
      this.activePreset = presetId;
      this.region = computeSourcePreset(
        presetId,
        aspect,
        this.manager.settings.defaultSliceAspect
      );
      this._applySourceCrop();
      if (persist) {
        this.manager.rememberStreamCrop(this._getStreamIdentities(), this.region, this.activePreset);
      }
      this.syncUI();
    }

    reset(persist = true) {
      this.closeDrawModal();
      this.region = { ...FULL_REGION };
      this.activePreset = "full";
      this._didAutoCrop = true;
      this._teardownCropSession(true);
      if (persist) {
        this.manager.rememberStreamCrop(this._getStreamIdentities(), this.region, "full");
      }
      this.syncUI();
    }

    syncUI() {
      if (!this.rootEl) return;

      const posLeft = this.manager.settings.buttonPosition === "top-left";
      this.rootEl.classList.toggle("dsc-pos-top-left", posLeft);

      const cropped = !isFullRegion(this.region);
      if (this.triggerBtn) {
        this.triggerBtn.classList.toggle("dsc-is-cropped", cropped);
      }

      const dims = this._getOriginalDimensions();
      const outRect = computePixelCropRect(this.region, dims.width, dims.height);

      if (this.triggerResSpan) {
        this.triggerResSpan.textContent =
          cropped && this.manager.settings.showResolutionBadge
            ? `${outRect.width}×${outRect.height}`
            : "";
      }

      if (this.metaSpan) {
        this.metaSpan.textContent = cropped
          ? `${outRect.width}×${outRect.height} (from ${dims.width}×${dims.height})`
          : `${dims.width}×${dims.height}`;
      }

      for (const [id, btn] of this._presetBtns.entries()) {
        btn.classList.toggle("dsc-selected", this.activePreset === id);
      }

      if (this.minimapBox) {
        this.minimapBox.style.left = `${(this.region.x * 100).toFixed(2)}%`;
        this.minimapBox.style.top = `${(this.region.y * 100).toFixed(2)}%`;
        this.minimapBox.style.width = `${(this.region.w * 100).toFixed(2)}%`;
        this.minimapBox.style.height = `${(this.region.h * 100).toFixed(2)}%`;
      }
    }

    renderSavedPresets() {
      if (!this.savedRowEl) return;
      const list = this.manager.savedPresets;
      this.savedRowEl.innerHTML = "";

      if (!list.length) {
        this.savedRowEl.style.display = "none";
        return;
      }
      this.savedRowEl.style.display = "flex";

      list.forEach((item, idx) => {
        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "dsc-saved-pill";
        pill.title = `Apply "${item.name}"`;

        const nameSpan = document.createElement("span");
        nameSpan.textContent = item.name;

        const delSpan = document.createElement("span");
        delSpan.className = "dsc-saved-del";
        delSpan.textContent = "×";
        delSpan.title = `Delete "${item.name}"`;
        delSpan.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.manager.deletePreset(idx);
        });

        pill.appendChild(nameSpan);
        pill.appendChild(delSpan);
        pill.addEventListener("click", () => {
          this.activePreset = "custom";
          this.setRegion(item.region);
        });

        this.savedRowEl.appendChild(pill);
      });
    }
  }

  StreamCropper.computePixelCropRect = computePixelCropRect;
  StreamCropper.computeSourcePreset = computeSourcePreset;
  StreamCropper.MediaStreamCropSession = MediaStreamCropSession;
  StreamCropper.isCroppedStream = (s) => Boolean(s && CROPPED_STREAMS.has(s));

  if (typeof module !== "undefined" && module.exports) {
    module.exports = StreamCropper;
  }
})();
