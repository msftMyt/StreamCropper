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
        if (cur.parentElement) {
          cur = cur.parentElement;
        } else if (cur._ownerDoc && cur !== cur._ownerDoc) {
          cur = cur._ownerDoc;
        } else if (cur.defaultView && cur !== cur.defaultView) {
          cur = cur.defaultView;
        } else {
          cur = null;
        }
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
      this.ownerDocument = ownerDoc;
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
      this.fullscreenElement = null;
      this.webkitFullscreenElement = null;
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
  const webCodecsGlobals = withWebCodecs
    ? {
        MediaStreamTrackProcessor: MockTrackProcessor,
        MediaStreamTrackGenerator: MockTrackGenerator,
        VideoFrame: MockVideoFrame,
        TransformStream,
        AbortController
      }
    : {};
  const windowObj = Object.assign(windowTarget, {
    document,
    closed: false,
    innerWidth: 1920,
    innerHeight: 1080,
    HTMLMediaElement: MockHTMLMediaElement,
    MutationObserver: MockMutationObserver,
    MediaStream: MockMediaStream,
    localStorage,
    requestAnimationFrame: (cb) => {
      const t = setTimeout(() => cb(Date.now()), 16);
      t.unref?.();
      return t;
    },
    cancelAnimationFrame: (id) => clearTimeout(id),
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
    clearInterval,
    ...webCodecsGlobals
  });
  document.defaultView = windowObj;

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
    webCodecsGlobals,
    makeEvent
  };
}

function loadPlugin({ asBetterDiscord = true, withWebCodecs = true, existingEnv = null, popoutWindows = null } = {}) {
  const env = existingEnv || createMockDOM({ withWebCodecs });
  const cjsModule = asBetterDiscord ? { exports: {} } : undefined;
  const bdStyles = new Map();
  const bdData = new Map();
  const popoutMap = popoutWindows instanceof Map ? popoutWindows : new Map();
  let getStoreCalls = 0;

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
          createTooltip: (node) => {
            if (node.ownerDocument !== env.document) {
              throw new Error("BdApi.UI.createTooltip called on secondary popout document");
            }
            return { destroy() {} };
          }
        },
        Webpack: {
          getStore: (name) => {
            getStoreCalls++;
            if (name === "PopoutWindowStore") {
              return {
                getWindowKeys: () => [...popoutMap.keys()],
                getWindow: (key) => popoutMap.get(key) ?? null
              };
            }
            return null;
          }
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
    popoutMap,
    getWebpackStoreCalls: () => getStoreCalls,
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

  // Odd fractional region and odd hardware decoder origin offsets always round to safe even-aligned NV12/I420 coordinates inside frame bounds
  const oddRect = computePixelCropRect({ x: 0.1333, y: 0.2111, w: 0.4111, h: 0.5333 }, 1920, 1080);
  assert.equal(oddRect.x % 2, 0);
  assert.equal(oddRect.y % 2, 0);
  assert.equal(oddRect.width % 2, 0);
  assert.equal(oddRect.height % 2, 0);
  assert.ok(oddRect.x + oddRect.width <= 1920);
  assert.ok(oddRect.y + oddRect.height <= 1080);

  const oddOriginRect = computePixelCropRect({ x: 0, y: 0, w: 1, h: 1 }, 1919, 1079, 3, 5);
  assert.equal(oddOriginRect.x % 2, 0);
  assert.equal(oddOriginRect.y % 2, 0);
  assert.equal(oddOriginRect.width % 2, 0);
  assert.equal(oddOriginRect.height % 2, 0);
  assert.ok(oddOriginRect.x >= 3);
  assert.ok(oddOriginRect.y >= 5);
  assert.ok(oddOriginRect.x + oddOriginRect.width <= 3 + 1919);
  assert.ok(oddOriginRect.y + oddOriginRect.height <= 5 + 1079);
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

test("7. Discord Stream Popout Window support: cross-realm MediaStream, style injection, crop recall, modal/tooltip isolation & cleanup", async () => {
  const popoutWindows = new Map();
  const { env, PluginClass, getWebpackStoreCalls } = loadPlugin({
    asBetterDiscord: true,
    withWebCodecs: true,
    popoutWindows
  });
  const plugin = new PluginClass();
  plugin.start();
  assert.equal(getWebpackStoreCalls(), 1, "PopoutWindowStore resolved once on start() and cached");

  // 1) Streamer plays in main window and user crops to "Right" (5120x1440 -> 2560x1440 at x=2560)
  const mainTrack = {
    id: "main-popout-track",
    kind: "video",
    getSettings: () => ({ width: 5120, height: 1440 })
  };
  const mainStream = Object.assign(new env.MediaStream([mainTrack]), { id: "stream-popout-streamer" });

  const mainStage = env.document.createElement("div");
  mainStage.style.position = "relative";
  mainStage.clientWidth = 1600;
  mainStage.clientHeight = 900;
  const mainBadge = env.document.createElement("span");
  mainBadge.textContent = "ultrawide-gamer";
  mainStage.appendChild(mainBadge);

  const mainVideo = env.document.createElement("video");
  mainVideo.srcObject = mainStream;
  mainVideo.clientWidth = 1600;
  mainVideo.clientHeight = 450;
  mainVideo.videoWidth = 5120;
  mainVideo.videoHeight = 1440;
  mainStage.appendChild(mainVideo);
  env.document.body.appendChild(mainStage);

  plugin.scan();

  const mainHud = mainStage.querySelector(".dsc-hud");
  const rightBtn = mainHud.querySelectorAll("button").find((b) => b.dataset.preset === "right");
  rightBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(PluginClass.isCroppedStream(mainVideo.srcObject), true, "Main window stream cropped");

  // 2) User pops out the stream into a separate Electron BrowserWindow (distinct Document, Window & MediaStream realm!)
  mainStage.remove();
  const popoutEnv = createMockDOM({ withWebCodecs: true });
  assert.notEqual(popoutEnv.MediaStream, env.MediaStream, "Popout window has its own distinct MediaStream constructor");
  popoutWindows.set("DISCORD_CALL_POPOUT", popoutEnv.window);

  const popoutVideoTrack = {
    id: "popout-video-track",
    kind: "video",
    getSettings: () => ({ width: 5120, height: 1440 })
  };
  const popoutAudioTrack = { id: "popout-audio-track", kind: "audio" };
  const popoutRawStream = Object.assign(
    new popoutEnv.MediaStream([popoutVideoTrack, popoutAudioTrack]),
    { id: "popout-stream-id" }
  );
  assert.equal(popoutRawStream instanceof env.MediaStream, false, "Cross-realm stream is not instanceof main MediaStream");
  assert.equal(PluginClass.isMediaStream(popoutRawStream, popoutEnv.window), true, "isMediaStream recognizes cross-realm stream");

  const popoutStage = popoutEnv.document.createElement("div");
  popoutStage.clientWidth = 1280;
  popoutStage.clientHeight = 720;
  const popoutBadge = popoutEnv.document.createElement("span");
  popoutBadge.textContent = "ultrawide-gamer";
  popoutStage.appendChild(popoutBadge);

  const popoutVideo = popoutEnv.document.createElement("video");
  popoutVideo.srcObject = popoutRawStream;
  popoutVideo.clientWidth = 1280;
  popoutVideo.clientHeight = 720;
  popoutVideo.videoWidth = 5120;
  popoutVideo.videoHeight = 1440;
  popoutStage.appendChild(popoutVideo);
  popoutEnv.document.body.appendChild(popoutStage);

  plugin.scan();
  assert.equal(getWebpackStoreCalls(), 1, "PopoutWindowStore never re-queried during scan()");

  // 3) Style sheet injected into popout's <head> & tooltip fell back cleanly to `title`
  const popoutStyle = popoutEnv.document.head.querySelector("#dsc-stream-cropper-styles");
  assert.ok(popoutStyle, "Stylesheet injected into popout document <head>");
  assert.equal(popoutStyle.ownerDocument, popoutEnv.document);

  const popoutTrigger = popoutStage.querySelector(".dsc-trigger");
  assert.ok(popoutTrigger, "Crop trigger mounted inside popout document");
  assert.equal(popoutTrigger.ownerDocument, popoutEnv.document, "Overlay DOM created via popout ownerDocument");
  assert.equal(popoutTrigger.title, "Crop stream source", "Popout trigger uses native title instead of main-doc BdApi tooltip");

  // 4) Auto-recalled the streamer's "Right" crop from the main window using popout's MediaStream realm!
  const popoutCroppedStream = popoutVideo.srcObject;
  assert.notEqual(popoutCroppedStream, popoutRawStream, "Popout video.srcObject replaced with cropped stream");
  assert.equal(PluginClass.isCroppedStream(popoutCroppedStream), true);
  assert.equal(popoutCroppedStream instanceof popoutEnv.MediaStream, true, "Output stream constructed with popout window's MediaStream");

  const rawPopoutFrame = popoutVideoTrack._pushFrame(5120, 1440, 99000);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(rawPopoutFrame.closed, true);
  assert.equal(popoutEnv.emittedFrames.length, 1);
  assert.deepEqual(
    { ...popoutEnv.emittedFrames[0].visibleRect },
    { x: 2560, y: 0, width: 2560, height: 1440 },
    "Recalled exact Right 2560x1440 crop in popout window"
  );

  // 5) Draw Custom Region modal & Escape key operate inside popout window/document, not main document
  popoutTrigger.dispatchEvent(popoutEnv.makeEvent("click"));
  const popoutDrawBtn = popoutStage.querySelector(".dsc-draw-full-btn");
  popoutDrawBtn.dispatchEvent(popoutEnv.makeEvent("click"));
  assert.ok(popoutEnv.document.body.querySelector(".dsc-draw-modal"), "Draw modal appended to popout document.body");
  assert.equal(env.document.body.querySelector(".dsc-draw-modal"), null, "Main document untouched by popout modal");

  popoutEnv.window.dispatchEvent(popoutEnv.makeEvent("keydown", { key: "Escape" }));
  assert.equal(popoutEnv.document.body.querySelector(".dsc-draw-modal"), null, "Escape on popout window closed popout draw modal");

  // 6) Closing popout window cleans up popout styles, observers, listeners, and controllers
  popoutEnv.window.closed = true;
  popoutEnv.window.dispatchEvent(popoutEnv.makeEvent("unload"));
  assert.equal(popoutEnv.document.getElementById("dsc-stream-cropper-styles"), null, "Popout stylesheet removed on unload");
  assert.equal(popoutEnv.document._observers.size, 0, "Popout MutationObserver disconnected");
  assert.equal(popoutStage.querySelector(".dsc-trigger"), null, "Popout controller destroyed");
  assert.equal(popoutVideo.srcObject, popoutRawStream, "Original popout stream restored cleanly");

  // 7) Also verify stop() cleans up an active popout window if still open when plugin stops
  const popoutEnv2 = createMockDOM({ withWebCodecs: false });
  popoutWindows.set("DISCORD_CALL_POPOUT_2", popoutEnv2.window);
  const stage2 = popoutEnv2.document.createElement("div");
  stage2.clientWidth = 1280;
  stage2.clientHeight = 720;
  const video2 = popoutEnv2.document.createElement("video");
  video2.srcObject = new popoutEnv2.MediaStream([{ kind: "video" }]);
  video2.clientWidth = 1280;
  video2.clientHeight = 720;
  stage2.appendChild(video2);
  popoutEnv2.document.body.appendChild(stage2);

  plugin.scan();
  assert.ok(popoutEnv2.document.getElementById("dsc-stream-cropper-styles"));
  assert.ok(stage2.querySelector(".dsc-trigger"));

  plugin.stop();
  assert.equal(popoutEnv2.document.getElementById("dsc-stream-cropper-styles"), null, "stop() removed active popout stylesheet");
  assert.equal(popoutEnv2.document._observers.size, 0, "stop() disconnected active popout observer");
  assert.equal(stage2.querySelector(".dsc-trigger"), null, "stop() destroyed active popout controller");
});

test("8. Fullscreen Mode support: Top-Layer modal mounting, dynamic fullscreenchange re-parenting, Escape capture & zero-interruption host re-homing", () => {
  const { env, PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });
  const plugin = new PluginClass();
  plugin.start();

  const videoTrack = {
    id: "fs-video-track",
    kind: "video",
    getSettings: () => ({ width: 5120, height: 1440 })
  };
  const audioTrack = { id: "fs-audio-track", kind: "audio" };
  const rawStream = new env.MediaStream([videoTrack, audioTrack]);

  // Normal inline stage container (static position -> promoted via .dsc-host-positioned)
  const normalStage = env.document.createElement("div");
  normalStage.clientWidth = 1600;
  normalStage.clientHeight = 900;

  // Dedicated fullscreen wrapper (e.g. Discord's fullscreen player root on a 3840x2160 monitor)
  const fullscreenWrapper = env.document.createElement("div");
  fullscreenWrapper.clientWidth = 3840;
  fullscreenWrapper.clientHeight = 2160;

  const video = env.document.createElement("video");
  video.srcObject = rawStream;
  video.clientWidth = 1600;
  video.clientHeight = 450;
  video.videoWidth = 5120;
  video.videoHeight = 1440;

  normalStage.appendChild(video);
  env.document.body.appendChild(normalStage);
  env.document.body.appendChild(fullscreenWrapper);

  plugin.scan();

  const controller = plugin.controllers.get(video);
  assert.ok(controller, "Controller attached to stream video");
  assert.equal(controller.host, normalStage, "Initially mounted on normalStage");
  assert.equal(normalStage.classList.contains("dsc-host-positioned"), true, "normalStage promoted to positioned");

  // 1) Start an active WebCodecs crop ("Center") before entering fullscreen
  const trigger = normalStage.querySelector(".dsc-trigger");
  trigger.dispatchEvent(env.makeEvent("click"));
  const centerBtn = normalStage.querySelectorAll("button").find((b) => b.dataset.preset === "center");
  centerBtn.dispatchEvent(env.makeEvent("click"));

  const activeSession = controller.cropSession;
  const activeCroppedStream = video.srcObject;
  assert.ok(activeSession && !activeSession.disposed, "Active MediaStreamCropSession running");
  assert.equal(PluginClass.isCroppedStream(activeCroppedStream), true);

  // 2) Verify getModalMountTarget falls back to parentElement if `<video>` leaf itself is fullscreenElement
  env.document.fullscreenElement = video;
  assert.equal(
    PluginClass.getModalMountTarget(env.document),
    normalStage,
    "Leaf <video> fullscreenElement falls back to parentElement instead of mounting <div> inside <video>"
  );

  // 3) Discord enters Fullscreen: moves `<video>` into `fullscreenWrapper` and sets `doc.fullscreenElement`
  fullscreenWrapper.appendChild(video);
  env.document.fullscreenElement = fullscreenWrapper;
  env.document.dispatchEvent(env.makeEvent("fullscreenchange"));

  assert.equal(controller.overlay.rootEl.parentElement, fullscreenWrapper, "Overlay rootEl re-homed onto fullscreenWrapper");
  assert.equal(fullscreenWrapper.classList.contains("dsc-host-positioned"), true, "fullscreenWrapper received dsc-host-positioned");
  assert.equal(normalStage.classList.contains("dsc-host-positioned"), false, "normalStage cleaned up dsc-host-positioned");
  assert.equal(controller.cropSession, activeSession, "Active MediaStreamCropSession preserved without interruption");
  assert.equal(activeSession.disposed, false, "Crop session was not disposed during fullscreen transition");
  assert.equal(video.srcObject, activeCroppedStream, "Cropped MediaStream stayed attached seamlessly");

  // 4) Open "Draw Custom Region" while in Fullscreen -> mounts inside `fullscreenWrapper` (Top Layer), NOT `doc.body`,
  //    and scales stage dimensions to `fullscreenWrapper` (3840x2160) instead of `window` (1920x1080)
  trigger.dispatchEvent(env.makeEvent("click"));
  const drawBtn = fullscreenWrapper.querySelector(".dsc-draw-full-btn");
  drawBtn.dispatchEvent(env.makeEvent("click"));

  const modalInFs = fullscreenWrapper.querySelector(".dsc-draw-modal");
  assert.ok(modalInFs, "Draw modal mounted inside fullscreenWrapper Top Layer");
  assert.equal(env.document.body.children.includes(modalInFs), false, "Draw modal is NOT a direct child of document.body during fullscreen");

  const drawStage = modalInFs.querySelector(".dsc-draw-stage");
  assert.ok(
    parseInt(drawStage.style.width, 10) > 1920,
    `Fullscreen draw stage scaled to 4K fullscreenWrapper (${drawStage.style.width}) rather than 1080p window`
  );

  // 5) Pressing Escape while drawing cancels ONLY the draw modal and stops propagation before Discord's document/React listener can exit fullscreen
  let discordFullscreenExitTriggered = false;
  env.document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") discordFullscreenExitTriggered = true;
  });
  const escCancelEvent = env.makeEvent("keydown", { key: "Escape" });
  modalInFs.dispatchEvent(escCancelEvent);

  assert.equal(controller.isDrawing, false, "Escape cancelled active Draw Custom Region modal");
  assert.equal(fullscreenWrapper.querySelector(".dsc-draw-modal"), null, "Draw modal removed on Escape");
  assert.equal(escCancelEvent.defaultPrevented, true, "Escape keydown preventDefault() called");
  assert.equal(discordFullscreenExitTriggered, false, "Window capture stopped Escape before reaching Discord's document listener");

  // 6) Re-open Draw Custom Region in fullscreen, then exit browser fullscreen while modal is still open ->
  //    `fullscreenchange` dynamically re-parents the open modal back to `doc.body` AND re-homes `overlay.rootEl` back to `normalStage`!
  trigger.dispatchEvent(env.makeEvent("click"));
  drawBtn.dispatchEvent(env.makeEvent("click"));
  const openModal = fullscreenWrapper.querySelector(".dsc-draw-modal");
  assert.ok(openModal, "Draw modal re-opened inside fullscreenWrapper");

  normalStage.appendChild(video);
  env.document.fullscreenElement = null;
  env.document.dispatchEvent(env.makeEvent("fullscreenchange"));

  assert.equal(openModal.parentElement, env.document.body, "Open draw modal dynamically re-parented back to document.body on fullscreen exit");
  assert.ok(
    parseInt(openModal.querySelector(".dsc-draw-stage").style.width, 10) <= 1400,
    "Draw stage resized back down to normal window bounds on fullscreen exit"
  );
  assert.equal(controller.overlay.rootEl.parentElement, normalStage, "Overlay rootEl re-homed back onto normalStage");
  assert.equal(normalStage.classList.contains("dsc-host-positioned"), true, "normalStage restored dsc-host-positioned");
  assert.equal(fullscreenWrapper.classList.contains("dsc-host-positioned"), false, "fullscreenWrapper cleaned up dsc-host-positioned");
  assert.equal(controller.cropSession, activeSession, "MediaStreamCropSession still uninterrupted after exiting fullscreen");
  assert.equal(video.srcObject, activeCroppedStream, "Cropped MediaStream still active after exiting fullscreen");

  plugin.stop();
});

test("9. Discord In-App Floating Mini-Player (PiP) & OS Picture-in-Picture crop retention, .dsc-compact UI & full-frame modal fallback", () => {
  const { env, PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });
  const plugin = new PluginClass();
  plugin.start();

  const videoTrack = {
    id: "pip-video-track",
    kind: "video",
    getSettings: () => ({ width: 5120, height: 1440 })
  };
  const audioTrack = { id: "pip-audio-track", kind: "audio" };
  const rawStream = Object.assign(new env.MediaStream([videoTrack, audioTrack]), { id: "pip-stream-alpha" });

  // 1) Start watching stream on 1600x900 stage, open HUD, and crop to "Center"
  const stageHost = env.document.createElement("div");
  stageHost.clientWidth = 1600;
  stageHost.clientHeight = 900;

  const video = env.document.createElement("video");
  video.srcObject = rawStream;
  video.clientWidth = 1600;
  video.clientHeight = 450;
  video.videoWidth = 5120;
  video.videoHeight = 1440;
  stageHost.appendChild(video);
  env.document.body.appendChild(stageHost);

  plugin.scan();

  const controller = plugin.controllers.get(video);
  assert.ok(controller, "Stage video controller mounted");
  const rootEl = controller.overlay.rootEl;
  assert.equal(rootEl.classList.contains("dsc-compact"), false, "Full stage is not compact");

  const trigger = stageHost.querySelector(".dsc-trigger");
  trigger.dispatchEvent(env.makeEvent("click"));
  assert.equal(controller.isOpen, true, "HUD opened on full stage");

  const centerBtn = stageHost.querySelectorAll("button").find((b) => b.dataset.preset === "center");
  centerBtn.dispatchEvent(env.makeEvent("click"));

  const croppedStream = video.srcObject;
  const activeSession = controller.cropSession;
  assert.equal(PluginClass.isCroppedStream(croppedStream), true, "Stream cropped on stage");
  assert.equal(controller.isOpen, true, "HUD still open before switching to #general");

  // 2) User navigates to `#general` text chat -> Discord shrinks the watched player into a 240x135 corner mini-player!
  stageHost.clientWidth = 240;
  stageHost.clientHeight = 135;
  video.clientWidth = 240;
  video.clientHeight = 135;

  plugin.scan();

  assert.equal(plugin.controllers.has(video), true, "Controller kept alive when shrunk to 240x135 mini-player");
  assert.equal(video.srcObject, croppedStream, "Cropped MediaStream stayed active in 240x135 mini-player");
  assert.equal(controller.cropSession, activeSession, "Crop session uninterrupted during shrink to mini-player");
  assert.equal(activeSession.disposed, false, "Crop session not disposed");
  assert.equal(rootEl.classList.contains("dsc-compact"), true, ".dsc-compact applied on 240x135 mini-player");
  assert.equal(controller.isOpen, false, "Open 336px HUD auto-closed cleanly so it does not overflow 240x135 mini-player");
  assert.equal(rootEl.classList.contains("dsc-open"), false, ".dsc-open class removed on auto-close");

  // 3) OS Picture-in-Picture / layout transition momentarily reports 0x0 client dimensions -> active crop still retained!
  stageHost.clientWidth = 0;
  stageHost.clientHeight = 0;
  video.clientWidth = 0;
  video.clientHeight = 0;

  plugin.scan();

  assert.equal(plugin.controllers.has(video), true, "Active crop retained even when video dimensions hit 0x0 during OS PiP");
  assert.equal(video.srcObject, croppedStream, "Cropped MediaStream preserved during 0x0 OS PiP state");

  // Restore 240x135 mini-player dimensions
  stageHost.clientWidth = 240;
  stageHost.clientHeight = 135;
  video.clientWidth = 240;
  video.clientHeight = 135;
  plugin.scan();

  // 4) Clicking compact `Crop` pill in 240x135 mini-player opens full-frame Draw Custom Region modal directly (with Reset button!)
  trigger.dispatchEvent(env.makeEvent("click"));
  assert.equal(controller.isOpen, false, "Did not open overflowing 336px HUD inside 240x135 mini-player");
  assert.equal(controller.isDrawing, true, "Clicking Crop in compact mini-player opened full-frame draw modal");

  const modal = env.document.body.querySelector(".dsc-draw-modal");
  assert.ok(modal, "Full-frame draw modal mounted in document.body");
  const modalResetBtn = modal.querySelector(".dsc-modal-reset-btn");
  assert.ok(modalResetBtn, "Draw modal includes 'Reset to Full Stream' button while stream is cropped");

  // Close modal via Cancel to keep crop remembered for the remount test, then verify Reset works too!
  env.window.dispatchEvent(env.makeEvent("keydown", { key: "Escape" }));
  assert.equal(controller.isDrawing, false, "Escape closed draw modal");

  // 5) Discord unmounts the stage `<video>` completely and mounts a fresh 240x135 floating mini-player `<video>` with the same stream ID!
  stageHost.remove();
  plugin.scan();
  assert.equal(plugin.controllers.size, 0, "Unmounted stage video cleaned up");

  // Also ensure multi-video participant camera grid tiles (e.g. two 220x124 tiles in a 460x260 grid) are NOT misdetected as floating mini-player
  const callGrid = env.document.createElement("div");
  callGrid.clientWidth = 460;
  callGrid.clientHeight = 260;
  const tileA = env.document.createElement("div");
  tileA.clientWidth = 192;
  tileA.clientHeight = 108;
  const camVideoA = env.document.createElement("video");
  camVideoA.srcObject = rawStream;
  camVideoA.clientWidth = 192;
  camVideoA.clientHeight = 108;
  tileA.appendChild(camVideoA);
  const tileB = env.document.createElement("div");
  tileB.clientWidth = 192;
  tileB.clientHeight = 108;
  const camVideoB = env.document.createElement("video");
  camVideoB.srcObject = new env.MediaStream([{ id: "cam-b", kind: "video" }]);
  camVideoB.clientWidth = 192;
  camVideoB.clientHeight = 108;
  tileB.appendChild(camVideoB);
  callGrid.append(tileA, tileB);
  env.document.body.appendChild(callGrid);

  // Mount the real standalone 240x135 floating mini-player with the same stream ID (`pip-stream-alpha`)
  const miniPlayerHost = env.document.createElement("div");
  miniPlayerHost.clientWidth = 240;
  miniPlayerHost.clientHeight = 135;
  const miniVideo = env.document.createElement("video");
  const remountedStream = Object.assign(
    new env.MediaStream([{ id: "pip-video-track-2", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }, audioTrack]),
    { id: "pip-stream-alpha" }
  );
  miniVideo.srcObject = remountedStream;
  miniVideo.clientWidth = 240;
  miniVideo.clientHeight = 135;
  miniVideo.videoWidth = 5120;
  miniVideo.videoHeight = 1440;
  miniPlayerHost.appendChild(miniVideo);
  env.document.body.appendChild(miniPlayerHost);

  plugin.scan();

  assert.equal(plugin.controllers.has(camVideoA), false, "Ignored multi-video participant grid tile");
  assert.equal(plugin.controllers.has(miniVideo), true, "Mounted controller onto newly created 240x135 floating mini-player");

  const miniController = plugin.controllers.get(miniVideo);
  assert.equal(PluginClass.isCroppedStream(miniVideo.srcObject), true, "Auto-restored remembered Center crop onto newly mounted 240x135 mini-player");
  assert.equal(miniController.activePreset, "center", "Recalled exact 'center' preset on mini-player");
  assert.equal(miniController.overlay.rootEl.classList.contains("dsc-compact"), true, "Newly mounted mini-player starts in .dsc-compact mode");

  // 6) Click compact Crop pill on newly mounted mini-player and click `Reset to Full Stream` inside the modal -> 1-click Reset!
  const miniTrigger = miniPlayerHost.querySelector(".dsc-trigger");
  miniTrigger.dispatchEvent(env.makeEvent("click"));
  const miniModal = env.document.body.querySelector(".dsc-draw-modal");
  assert.ok(miniModal, "Draw modal opened from newly mounted mini-player");
  const resetFromModal = miniModal.querySelector(".dsc-modal-reset-btn");
  assert.ok(resetFromModal, "Reset to Full Stream button rendered in modal");
  resetFromModal.dispatchEvent(env.makeEvent("click"));

  assert.equal(miniController.isDrawing, false, "Reset to Full Stream closed the draw modal");
  assert.equal(miniVideo.srcObject, remountedStream, "1-click Reset from modal restored uncropped stream on mini-player");

  plugin.stop();
});

test("10. React WindowPortal adopting existing <video> into Popout Window (and wiping popout <head>): never renders unstyled overlay", () => {
  const mainEnv = createMockDOM({ withWebCodecs: true });
  const popoutEnv = createMockDOM({ withWebCodecs: true });

  // Simulate PopoutWindowStore NOT returning the window (or returning empty keys) AND Discord
  // adopting the existing main-window `<video>` directly into `popoutEnv.document`!
  const { PluginClass } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true, existingEnv: mainEnv });
  const plugin = new PluginClass();
  plugin.start();

  const mainStage = mainEnv.document.createElement("div");
  mainStage.clientWidth = 1280;
  mainStage.clientHeight = 720;

  const stream = Object.assign(
    new mainEnv.MediaStream([{ id: "adopt-track-1", kind: "video", getSettings: () => ({ width: 1280, height: 720 }) }]),
    { id: "adopt-stream-1" }
  );
  const video = mainEnv.document.createElement("video");
  video.srcObject = stream;
  video.clientWidth = 1280;
  video.clientHeight = 720;
  mainStage.appendChild(video);
  mainEnv.document.body.appendChild(mainStage);

  plugin.scan();
  assert.ok(mainStage.querySelector(".dsc-root"), "Mounted in main window initially");

  // Discord pops out the stream by moving the SAME `<video>` node into `popoutEnv.document`!
  const popoutStage = popoutEnv.document.createElement("div");
  popoutStage.clientWidth = 1280;
  popoutStage.clientHeight = 720;
  popoutEnv.document.body.appendChild(popoutStage);

  video._ownerDoc = popoutEnv.document;
  popoutStage.appendChild(video);

  plugin.scan();

  // 1) Old main-document controller was replaced by a popout-document controller
  const popoutRoot = popoutStage.querySelector(".dsc-root");
  assert.ok(popoutRoot, "Fresh overlay mounted inside popout stage");
  assert.equal(popoutRoot.ownerDocument, popoutEnv.document, "Overlay elements belong to popout document");
  assert.ok(popoutEnv.document.getElementById("dsc-stream-cropper-styles"), "Stylesheet injected into popout <head>");
  assert.ok(popoutRoot.querySelector("style"), "Local fallback <style> embedded inside popout .dsc-root");

  // 2) Even if Discord's WindowPortal wipes `popoutEnv.document.head.innerHTML = ""`, styles are re-injected on scan AND embedded locally!
  popoutEnv.document.head.innerHTML = "";
  plugin.scan();
  assert.ok(popoutEnv.document.getElementById("dsc-stream-cropper-styles"), "Re-injected <head> stylesheet after WindowPortal wipe");

  plugin.stop();
});

