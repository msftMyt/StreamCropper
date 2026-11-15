import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, "StreamCropper.plugin.js");
const SOURCE = fs.readFileSync(PLUGIN_PATH, "utf8");

function createMockDOM({ withWebCodecs = true } = {}) {
  class MockClassList {
    constructor(el) {
      this.el = el;
      this.set = new Set();
    }
    _syncFromAttr(str) {
      this.set = new Set(String(str || "").split(/\s+/).filter(Boolean));
    }
    _writeAttr() {
      this.el._className = [...this.set].join(" ");
    }
    add(...names) {
      for (const n of names) if (n) this.set.add(n);
      this._writeAttr();
    }
    remove(...names) {
      for (const n of names) this.set.delete(n);
      this._writeAttr();
    }
    toggle(name, force) {
      const shouldHave = force === undefined ? !this.set.has(name) : Boolean(force);
      if (shouldHave) this.set.add(name);
      else this.set.delete(name);
      this._writeAttr();
      return shouldHave;
    }
    contains(name) {
      return this.set.has(name);
    }
  }

  class MockEventTarget {
    constructor() {
      this._listeners = new Map();
    }
    addEventListener(type, fn, opts) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      const signal = opts && typeof opts === "object" ? opts.signal : null;
      if (signal?.aborted) return;
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push({ fn, capture });
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => this.removeEventListener(type, fn, capture), { once: true });
      }
    }
    removeEventListener(type, fn, opts) {
      const arr = this._listeners.get(type);
      if (!arr) return;
      const capture = opts === undefined ? null : typeof opts === "boolean" ? opts : Boolean(opts && opts.capture);
      this._listeners.set(
        type,
        arr.filter((item) => item.fn !== fn || (capture !== null && item.capture !== capture))
      );
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      const pathNodes = [];
      let cur = this;
      while (cur) {
        pathNodes.push(cur);
        cur = cur.parentElement || (cur._ownerDoc && cur !== cur._ownerDoc ? cur._ownerDoc : null);
      }

      for (let i = pathNodes.length - 1; i > 0; i--) {
        const node = pathNodes[i];
        event.currentTarget = node;
        const list = (node._listeners.get(event.type) || []).filter((l) => l.capture);
        for (const item of list) {
          item.fn.call(node, event);
          if (event._immediateStopped) break;
        }
        if (event._stopped) return !event.defaultPrevented;
      }

      const targetListeners = [...(this._listeners.get(event.type) || [])];
      event.currentTarget = this;
      for (const item of targetListeners) {
        item.fn.call(this, event);
        if (event._immediateStopped) break;
      }
      if (event._stopped || event.bubbles === false) return !event.defaultPrevented;

      for (let i = 1; i < pathNodes.length; i++) {
        const node = pathNodes[i];
        event.currentTarget = node;
        const list = (node._listeners.get(event.type) || []).filter((l) => !l.capture);
        for (const item of list) {
          item.fn.call(node, event);
          if (event._immediateStopped) break;
        }
        if (event._stopped) break;
      }
      return !event.defaultPrevented;
    }
  }

  class MockMediaStream {
    constructor(tracks = []) {
      this._tracks = [...tracks];
    }
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === "video");
    }
    getAudioTracks() {
      return this._tracks.filter((t) => t.kind === "audio");
    }
    addTrack(track) {
      this._tracks.push(track);
    }
  }

  class MockHTMLMediaElement extends MockEventTarget {
    constructor() {
      super();
      this._srcObject = null;
    }
    get srcObject() {
      return this._srcObject;
    }
    set srcObject(val) {
      this._srcObject = val;
    }
    play() {
      return Promise.resolve();
    }
    pause() {}
  }

  class MockElement extends MockHTMLMediaElement {
    constructor(tagName, ownerDoc) {
      super();
      this.nodeName = tagName.toUpperCase();
      this.tagName = this.nodeName;
      this._ownerDoc = ownerDoc;
      this.parentElement = null;
      this.children = [];
      this.attributes = new Map();
      this.dataset = {};
      this.style = {
        position: "",
        left: "",
        top: "",
        width: "",
        height: "",
        display: ""
      };
      this._className = "";
      this.classList = new MockClassList(this);
      this.id = "";
      this.textContent = "";
      this._innerHTML = "";
      this.clientWidth = 0;
      this.clientHeight = 0;
      this.width = 0;
      this.height = 0;
      this._rect = { left: 0, top: 0, width: 0, height: 0 };
      this.value = "";
      this.checked = false;
    }

    get className() {
      return this._className;
    }
    set className(val) {
      this._className = String(val || "");
      this.classList._syncFromAttr(this._className);
    }

    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(val) {
      this._innerHTML = String(val || "");
      this.children = [];
    }

    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === this._ownerDoc.documentElement) return true;
        cur = cur.parentElement;
      }
      return false;
    }

    getContext(kind) {
      if (kind === "2d") {
        return { drawImage() {} };
      }
      return null;
    }

    captureStream() {
      return new MockMediaStream([{ kind: "video", stop() {} }]);
    }

    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
    }
    getAttribute(k) {
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === "object") this.appendChild(n);
      }
    }
    focus() {}
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
      this._ownerDoc._notifyMutation();
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentElement = null;
        this._ownerDoc._notifyMutation();
      }
      return child;
    }
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    }
    getBoundingClientRect() {
      return {
        left: this._rect.left || parseFloat(this.style.left) || 0,
        top: this._rect.top || parseFloat(this.style.top) || 0,
        width: this._rect.width || parseFloat(this.style.width) || this.clientWidth || 0,
        height: this._rect.height || parseFloat(this.style.height) || this.clientHeight || 0
      };
    }
    querySelectorAll(selector) {
      const out = [];
      const visit = (el) => {
        for (const child of el.children) {
          if (matchesSelector(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function matchesSelector(el, selector) {
    if (selector.startsWith("#")) return el.id === selector.slice(1);
    if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
    return el.tagName === selector.toUpperCase();
  }

  class MockDocument extends MockEventTarget {
    constructor() {
      super();
      this._observers = new Set();
      this.documentElement = new MockElement("html", this);
      this.head = new MockElement("head", this);
      this.body = new MockElement("body", this);
      this.documentElement.appendChild(this.head);
      this.documentElement.appendChild(this.body);
    }
    createElement(tag) {
      return new MockElement(tag, this);
    }
    getElementById(id) {
      return this.documentElement.querySelector(`#${id}`);
    }
    querySelectorAll(sel) {
      return this.documentElement.querySelectorAll(sel);
    }
    querySelector(sel) {
      return this.documentElement.querySelector(sel);
    }
    _notifyMutation() {
      for (const obs of this._observers) obs._trigger();
    }
  }

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this._doc = null;
    }
    observe(target) {
      this._doc = target._ownerDoc;
      if (this._doc) this._doc._observers.add(this);
    }
    disconnect() {
      if (this._doc) this._doc._observers.delete(this);
    }
    _trigger() {
      this.cb([]);
    }
  }

  // WebCodecs mocks simulating Chromium/Electron zero-copy VideoFrame cropping
  const emittedFrames = [];
  class MockVideoFrame {
    constructor(src, init = {}) {
      const rect = init.visibleRect || {
        x: 0,
        y: 0,
        width: src.codedWidth || 5120,
        height: src.codedHeight || 1440
      };
      this.codedWidth = rect.width;
      this.codedHeight = rect.height;
      this.displayWidth = rect.width;
      this.displayHeight = rect.height;
      this.visibleRect = rect;
      this.timestamp = init.timestamp ?? src.timestamp ?? 0;
      this.closed = false;
    }
    close() {
      this.closed = true;
    }
  }

  class MockTrackProcessor {
    constructor({ track }) {
      this.track = track;
      this.readable = new ReadableStream({
        start(controller) {
          track._pushFrame = (w, h, ts = 1000, visibleRect = null) => {
            const rawFrame = {
              codedWidth: w,
              codedHeight: h,
              displayWidth: visibleRect ? visibleRect.width : w,
              displayHeight: visibleRect ? visibleRect.height : h,
              visibleRect,
              timestamp: ts,
              closed: false,
              close() {
                this.closed = true;
              }
            };
            controller.enqueue(rawFrame);
            return rawFrame;
          };
          track._failStream = (err) => controller.error(err);
        }
      });
    }
  }

  class MockTrackGenerator {
    constructor({ kind }) {
      this.kind = kind;
      this.stopped = false;
      this.writable = new WritableStream({
        write(frame) {
          emittedFrames.push(frame);
        }
      });
    }
    stop() {
      this.stopped = true;
    }
  }

  const storageMap = new Map();
  const localStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
    clear: () => storageMap.clear()
  };

  const document = new MockDocument();
  const windowTarget = new MockEventTarget();
  const windowObj = Object.assign(windowTarget, {
    document,
    innerWidth: 1920,
    innerHeight: 1080,
    HTMLMediaElement: MockHTMLMediaElement,
    MutationObserver: MockMutationObserver,
    MediaStream: MockMediaStream,
    localStorage,
    getComputedStyle: (el) => ({
      position: el.classList.contains("dsc-host-positioned")
        ? "relative"
        : el.style.position || "static"
    }),
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    },
    clearInterval
  });

  function makeEvent(type, props = {}) {
    return {
      type,
      bubbles: true,
      defaultPrevented: false,
      _stopped: false,
      _immediateStopped: false,
      stopPropagation() {
        this._stopped = true;
      },
      stopImmediatePropagation() {
        this._stopped = true;
        this._immediateStopped = true;
      },
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...props
    };
  }

  return {
    window: windowObj,
    document,
    HTMLMediaElement: MockHTMLMediaElement,
    MediaStream: MockMediaStream,
    localStorage,
    emittedFrames,
    webCodecsGlobals: withWebCodecs
      ? {
          MediaStreamTrackProcessor: MockTrackProcessor,
          MediaStreamTrackGenerator: MockTrackGenerator,
          VideoFrame: MockVideoFrame,
          TransformStream,
          AbortController
        }
      : {},
    makeEvent
  };
}

function loadPlugin({ asBetterDiscord = true, withWebCodecs = true, existingEnv = null } = {}) {
  const env = existingEnv || createMockDOM({ withWebCodecs });
  const cjsModule = asBetterDiscord ? { exports: {} } : undefined;
  const bdStyles = new Map();
  const bdData = new Map();

  const BdApi = asBetterDiscord
    ? {
        DOM: {
          addStyle: (id, css) => bdStyles.set(id, css),
          removeStyle: (id) => bdStyles.delete(id)
        },
        Data: {
          load: (plugin, key) => bdData.get(`${plugin}:${key}`),
          save: (plugin, key, val) => bdData.set(`${plugin}:${key}`, val)
        },
        UI: {
          buildSettingsPanel: (spec) => spec,
          showToast: () => {},
          createTooltip: () => ({ destroy() {} })
        },
        Logger: {
          warn: () => {}
        }
      }
    : undefined;

  const sandbox = {
    window: env.window,
    document: env.document,
    HTMLMediaElement: env.HTMLMediaElement,
    MutationObserver: env.window.MutationObserver,
    MediaStream: env.MediaStream,
    AbortController,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    localStorage: env.localStorage,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    },
    clearInterval,
    console,
    ...env.webCodecsGlobals,
    ...(asBetterDiscord ? { module: cjsModule, exports: cjsModule.exports, BdApi } : {})
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "StreamCropper.plugin.js" });
  return {
    env,
    BdApi,
    bdStyles,
    bdData,
    PluginClass: asBetterDiscord ? cjsModule.exports : env.window.DiscordStreamCropper
  };
}

test("1. BetterDiscord submission quality: JSDoc metadata, BdApi integration, strict CSP, zero global/prototype mutation", () => {
  assert.match(SOURCE, /@name\s+StreamCropper/);
  assert.match(SOURCE, /@author\s+msftMyt/);
  assert.match(SOURCE, /@version\s+1\.0\.0/);
  assert.match(SOURCE, /@website\s+https:\/\/github\.com\/msftMyt\/StreamCropper/);
  assert.match(SOURCE, /@source\s+https:\/\/github\.com\/msftMyt\/StreamCropper\/blob\/main\/StreamCropper\.plugin\.js/);

  // Only @website and @source metadata lines may contain https:// URLs; body has zero remote fetches/imports
  const bodyWithoutHeader = SOURCE.replace(/^\/\*\*[\s\S]*?\*\//, "");
  assert.doesNotMatch(bodyWithoutHeader, /https?:\/\//i);
  assert.doesNotMatch(SOURCE, /@import/i);
  assert.doesNotMatch(SOURCE, /\.[a-zA-Z]+_[a-f0-9]{5,}\b/);
  assert.doesNotMatch(SOURCE, /child_process/);
  assert.doesNotMatch(SOURCE, /window\.__/);
  assert.doesNotMatch(SOURCE, /Object\.defineProperty\(\s*proto/);

  const { env, PluginClass, bdStyles } = loadPlugin({ asBetterDiscord: true });
  const plugin = new PluginClass({ name: "StreamCropper", version: "1.0.0" });
  plugin.start();
  assert.equal(bdStyles.has("dsc-stream-cropper-styles"), true, "Uses BdApi.DOM.addStyle");
  assert.equal(typeof plugin.observer, "function", "Implements native BetterDiscord observer(mutation) hook");
  assert.equal(typeof plugin.onSwitch, "function", "Implements native BetterDiscord onSwitch() hook");
  assert.equal("DiscordStreamCropper" in env.window, false, "Does not pollute window globals");
  assert.equal("StreamCropper" in env.window, false, "Does not pollute window globals");

  // Settings panel delegates directly to BdApi.UI.buildSettingsPanel
  const settingsSpec = plugin.getSettingsPanel();
  assert.equal(Array.isArray(settingsSpec.settings), true);
  assert.equal(settingsSpec.settings.length, 5);
  settingsSpec.onChange(null, "buttonPosition", "top-left");
  assert.equal(plugin.settings.buttonPosition, "top-left");

  plugin.stop();
  assert.equal(bdStyles.has("dsc-stream-cropper-styles"), false, "Cleans up via BdApi.DOM.removeStyle");
});

test("2. Even-aligned pixel crop math & 32:9 -> 2560x1440 (16:9) native monitor source extraction", () => {
  const { PluginClass } = loadPlugin({ asBetterDiscord: true });
  const { computePixelCropRect, computeSourcePreset } = PluginClass;

  // 5120x1440 (32:9) stream -> Center preset extracts exact 2560x1440 (16:9) source!
  const center = computeSourcePreset("center", 5120 / 1440, "16:9");
  const rect = computePixelCropRect(center, 5120, 1440);
  assert.deepEqual({ ...rect }, { x: 1280, y: 0, width: 2560, height: 1440 });

  const left = computeSourcePreset("left", 5120 / 1440, "16:9");
  assert.deepEqual({ ...computePixelCropRect(left, 5120, 1440) }, { x: 0, y: 0, width: 2560, height: 1440 });

  const right = computeSourcePreset("right", 5120 / 1440, "16:9");
  assert.deepEqual({ ...computePixelCropRect(right, 5120, 1440) }, { x: 2560, y: 0, width: 2560, height: 1440 });

  // Odd fractional region always rounds to safe even-aligned NV12/I420 coordinates inside frame bounds
  const oddRect = computePixelCropRect({ x: 0.1333, y: 0.2111, w: 0.4111, h: 0.5333 }, 1920, 1080);
  assert.equal(oddRect.x % 2, 0);
  assert.equal(oddRect.y % 2, 0);
  assert.equal(oddRect.width % 2, 0);
  assert.equal(oddRect.height % 2, 0);
  assert.ok(oddRect.x + oddRect.width <= 1920);
  assert.ok(oddRect.y + oddRect.height <= 1080);
});

test("3. True WebCodecs MediaStream replacement, React srcObject re-render protection, Audio preservation & Reset", async () => {
  const { env, PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });
  const plugin = new PluginClass();
  plugin.start();

  const videoTrack = {
    kind: "video",
    getSettings: () => ({ width: 5120, height: 1440 }),
    stop() {
      this.stopped = true;
    }
  };
  const audioTrack = {
    kind: "audio",
    stop() {
      this.stopped = true;
    }
  };
  const rawUltrawideStream = new env.MediaStream([videoTrack, audioTrack]);

  const playerHost = env.document.createElement("div");
  playerHost.style.position = "relative";
  playerHost.clientWidth = 1740;
  playerHost.clientHeight = 610;

  const video = env.document.createElement("video");
  video.srcObject = rawUltrawideStream;
  video.clientWidth = 1740;
  video.clientHeight = 490;
  video.videoWidth = 5120;
  video.videoHeight = 1440;

  playerHost.appendChild(video);
  env.document.body.appendChild(playerHost);

  plugin.scan();

  // Open HUD and click "Center"
  const trigger = playerHost.querySelector(".dsc-trigger");
  assert.ok(trigger, "Trigger pill mounted on player container");
  trigger.dispatchEvent(env.makeEvent("click"));

  const hud = playerHost.querySelector(".dsc-hud");
  const centerBtn = hud.querySelectorAll("button").find((b) => b.dataset.preset === "center");
  centerBtn.dispatchEvent(env.makeEvent("click"));

  // 1) Discord's <video>.srcObject is now a REAL cropped MediaStream (zero CSS transforms on <video>!)
  const activeStream = video.srcObject;
  assert.notEqual(activeStream, rawUltrawideStream, "Replaced video.srcObject with cropped MediaStream");
  assert.equal(PluginClass.isCroppedStream(activeStream), true);
  assert.equal("__dscCroppedStream" in activeStream, false, "Does not mutate MediaStream instances with custom properties");
  assert.deepEqual(activeStream.getAudioTracks(), [audioTrack], "Original stream audio track preserved untouched");
  assert.equal(video.style.transform || "", "", "Zero CSS transform hacks applied to Discord's <video>");

  // 2) Push a 5120x1440 frame through WebCodecs processor -> verify output VideoFrame is 2560x1440!
  const rawFrame = videoTrack._pushFrame(5120, 1440, 42000);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(rawFrame.closed, true, "Input VideoFrame closed cleanly (zero GPU memory leak)");
  assert.equal(env.emittedFrames.length, 1);
  assert.equal(env.emittedFrames[0].codedWidth, 2560);
  assert.equal(env.emittedFrames[0].codedHeight, 1440);

  // 3) Simulate Discord React re-render re-assigning `video.srcObject = rawUltrawideStream`:
  // Interceptor keeps the cropped stream active without losing the crop!
  video.srcObject = rawUltrawideStream;
  assert.equal(video.srcObject, activeStream, "React re-render did not clobber cropped MediaStream");

  // 4) Clicking Reset restores the exact original rawUltrawideStream onto Discord's <video>
  const resetBtn = hud.querySelector(".dsc-reset-btn");
  resetBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(video.srcObject, rawUltrawideStream, "Original stream restored on Reset");
  assert.equal(Boolean(audioTrack.stopped), false, "Original audio track never stopped on Reset");

  plugin.stop();
});

test("4. Canvas captureStream fallback & clean lifecycle restart", () => {
  const env = createMockDOM({ withWebCodecs: false });
  const stage = env.document.createElement("div");
  stage.clientWidth = 1280;
  stage.clientHeight = 720;
  const rawStream = new env.MediaStream([{ kind: "video" }]);
  const video = env.document.createElement("video");
  video.srcObject = rawStream;
  video.clientWidth = 1280;
  video.clientHeight = 720;
  stage.appendChild(video);
  env.document.body.appendChild(stage);

  const { PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: false, existingEnv: env });
  const first = new PluginClass();
  first.start();

  const hud = stage.querySelector(".dsc-hud");
  const leftBtn = hud.querySelectorAll("button").find((b) => b.dataset.preset === "left");
  leftBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(PluginClass.isCroppedStream(video.srcObject), true, "Canvas captureStream fallback produced cropped MediaStream");

  // Stopping restores original stream and cleans up all UI nodes & instance properties
  first.stop();
  assert.equal(video.srcObject, rawStream, "Original stream restored on stop()");
  assert.equal(Object.prototype.hasOwnProperty.call(video, "srcObject"), false, "Per-element srcObject accessor removed cleanly");
  assert.equal(stage.querySelectorAll(".dsc-trigger").length, 0);
});

test("5. Auto-remember crop when clicking off a streamer and clicking back (both same-video switch & full DOM remount)", () => {
  const { env, PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });
  const plugin = new PluginClass();
  plugin.start();

  const playerStreamA = Object.assign(
    new env.MediaStream([{ id: "track-alpha", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]),
    { id: "stream-alpha" }
  );
  const playerStreamB = Object.assign(
    new env.MediaStream([{ id: "track-beta", kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) }]),
    { id: "stream-beta" }
  );

  const stage = env.document.createElement("div");
  stage.style.position = "relative";
  stage.clientWidth = 1720;
  stage.clientHeight = 960;

  const badge = env.document.createElement("span");
  badge.textContent = "streamer-alpha";
  stage.appendChild(badge);

  const video = env.document.createElement("video");
  video.srcObject = playerStreamA;
  video.clientWidth = 1720;
  video.clientHeight = 480;
  video.videoWidth = 5120;
  video.videoHeight = 1440;
  stage.appendChild(video);
  env.document.body.appendChild(stage);

  plugin.scan();

  // 1) User crops `streamer-alpha`'s 32:9 stream to "Left"
  const hud = stage.querySelector(".dsc-hud");
  const leftBtn = hud.querySelectorAll("button").find((b) => b.dataset.preset === "left");
  leftBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(PluginClass.isCroppedStream(video.srcObject), true, "alpha stream cropped");

  // 2) User clicks onto `streamer-beta`'s normal 16:9 stream -> switches cleanly to uncropped `playerStreamB`!
  badge.textContent = "streamer-beta";
  video.srcObject = playerStreamB;
  assert.equal(video.srcObject, playerStreamB, "beta normal 16:9 stream stays uncropped");

  // 3) User clicks back onto `streamer-alpha`'s stream -> automatically remembers and restores Left crop!
  badge.textContent = "streamer-alpha";
  video.srcObject = playerStreamA;
  assert.equal(PluginClass.isCroppedStream(video.srcObject), true, "Switching back to alpha auto-restored crop immediately");

  // 4) User leaves stream completely (Discord unmounts `<video>`), then clicks Watch Stream again (new `<video>` + new WebRTC stream ID)
  stage.remove();
  plugin.scan();

  const newStage = env.document.createElement("div");
  newStage.style.position = "relative";
  newStage.clientWidth = 1720;
  newStage.clientHeight = 960;
  const newBadge = env.document.createElement("span");
  newBadge.textContent = "streamer-alpha";
  newStage.appendChild(newBadge);

  const freshAlphaStream = Object.assign(
    new env.MediaStream([{ id: "track-alpha-rejoined", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]),
    { id: "stream-alpha-rejoined" }
  );
  const newVideo = env.document.createElement("video");
  newVideo.srcObject = freshAlphaStream;
  newVideo.clientWidth = 1720;
  newVideo.clientHeight = 480;
  newVideo.videoWidth = 5120;
  newVideo.videoHeight = 1440;
  newStage.appendChild(newVideo);
  env.document.body.appendChild(newStage);

  plugin.scan();
  assert.equal(PluginClass.isCroppedStream(newVideo.srcObject), true, "Re-mounting alpha stream auto-restored saved crop from persistent memory");

  plugin.stop();
});

test("6. Async WebCodecs mid-stream error recovery, hardware visibleRect offset math, in-place region update & ARIA/keyboard controls", async () => {
  const { env, PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });
  const { computePixelCropRect } = PluginClass;

  // 1) Hardware-decoded VideoFrame with non-zero visibleRect padding offset (ox=16, oy=8)
  const paddedRect = computePixelCropRect({ x: 0.25, y: 0, w: 0.5, h: 1 }, 5120, 1440, 16, 8);
  assert.deepEqual({ ...paddedRect }, { x: 1296, y: 8, width: 2560, height: 1440 });

  const plugin = new PluginClass();
  plugin.start();

  const videoTrack = {
    id: "hw-track-1",
    kind: "video",
    readyState: "live",
    getSettings: () => ({ width: 5120, height: 1440 })
  };
  const audioTrack = { id: "hw-audio-1", kind: "audio", stop() { this.stopped = true; } };
  const rawStream = new env.MediaStream([videoTrack, audioTrack]);

  const stage = env.document.createElement("div");
  stage.style.position = "relative";
  stage.clientWidth = 1600;
  stage.clientHeight = 900;

  const video = env.document.createElement("video");
  video.srcObject = rawStream;
  video.clientWidth = 1600;
  video.clientHeight = 450;
  video.videoWidth = 5120;
  video.videoHeight = 1440;
  stage.appendChild(video);
  env.document.body.appendChild(stage);

  plugin.scan();

  const trigger = stage.querySelector(".dsc-trigger");
  const hud = stage.querySelector(".dsc-hud");
  const minimap = hud.querySelector(".dsc-minimap");

  // 2) ARIA attributes update accurately on open / preset selection / close
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  trigger.dispatchEvent(env.makeEvent("click"));
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(hud.getAttribute("role"), "dialog");

  const centerBtn = hud.querySelectorAll("button").find((b) => b.dataset.preset === "center");
  centerBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(centerBtn.getAttribute("aria-pressed"), "true");

  const webCodecsStream = video.srcObject;
  assert.equal(PluginClass.isCroppedStream(webCodecsStream), true);

  // 3) Keyboard arrow nudging updates region IN-PLACE without reconstructing MediaStream
  minimap.dispatchEvent(env.makeEvent("keydown", { key: "ArrowRight", shiftKey: true }));
  assert.equal(video.srcObject, webCodecsStream, "MediaStream updated in-place without reconstruction");
  assert.equal(centerBtn.getAttribute("aria-pressed"), "false");

  // 4) Saved preset renders sibling buttons (apply + delete) rather than invalid nested buttons
  const saveBtn = hud.querySelector(".dsc-save-btn");
  saveBtn.dispatchEvent(env.makeEvent("click"));
  const savedPill = hud.querySelector(".dsc-saved-pill");
  assert.equal(savedPill.tagName, "DIV");
  assert.equal(savedPill.querySelectorAll("button").length, 2, "Sibling apply and delete buttons");

  // 5) Simulate asynchronous WebCodecs stream failure -> automatically swaps <video>.srcObject to canvas fallback!
  videoTrack._failStream(new Error("GPU decoder context lost"));
  await new Promise((r) => setTimeout(r, 30));

  const recoveredStream = video.srcObject;
  assert.notEqual(recoveredStream, webCodecsStream, "Replaced failed WebCodecs stream");
  assert.equal(PluginClass.isCroppedStream(recoveredStream), true, "Switched seamlessly to canvas fallback stream");
  assert.deepEqual(recoveredStream.getAudioTracks(), [audioTrack], "Preserved original audio track across fallback");

  plugin.stop();
  assert.equal(Boolean(audioTrack.stopped), false, "Original audio track never stopped on plugin teardown");
});


