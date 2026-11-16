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

  class MockMediaStream extends MockEventTarget {
    constructor(tracks = []) {
      super();
      this._tracks = [...tracks];
    }
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === "video");
    }
    getAudioTracks() {
      return this._tracks.filter((t) => t.kind === "audio");
    }
    addTrack(track) {
      if (!this._tracks.includes(track)) this._tracks.push(track);
    }
    removeTrack(track) {
      const idx = this._tracks.indexOf(track);
      if (idx >= 0) this._tracks.splice(idx, 1);
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
      this._textContent = "";
      this._innerHTML = "";
      this.clientWidth = 0;
      this.clientHeight = 0;
      this.width = 0;
      this.height = 0;
      this._rect = { left: 0, top: 0, width: 0, height: 0 };
      this.value = "";
      this.checked = false;
    }

    get textContent() {
      if (this.children.length === 0) return this._textContent || "";
      return this.children.map((c) => c.textContent).join("");
    }
    set textContent(val) {
      this._textContent = String(val ?? "");
      this.children = [];
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
      for (const child of this.children) {
        child.parentElement = null;
      }
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
    focus() {
      if (this._ownerDoc) {
        this._ownerDoc.activeElement = this;
      }
    }
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      const syncOwnerDoc = (node, doc) => {
        node._ownerDoc = doc;
        node.ownerDocument = doc;
        for (const sub of node.children || []) {
          syncOwnerDoc(sub, doc);
        }
      };
      syncOwnerDoc(child, this.ownerDocument);
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
    closest(selector) {
      let cur = this;
      while (cur) {
        if (matchesSelector(cur, selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  }

  function matchesSingleSelector(el, single) {
    const s = single.trim();
    if (!s) return false;
    if (s.startsWith("#")) return el.id === s.slice(1);
    if (s.startsWith(".")) return el.classList.contains(s.slice(1));
    return el.tagName === s.toUpperCase();
  }

  function matchesSelector(el, selector) {
    if (selector.includes(",")) {
      return selector.split(",").some((part) => matchesSingleSelector(el, part));
    }
    return matchesSingleSelector(el, selector);
  }

  class MockDocument extends MockEventTarget {
    constructor() {
      super();
      this._observers = new Set();
      this.fullscreenElement = null;
      this.webkitFullscreenElement = null;
      this.activeElement = null;
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
    AbortSignal,
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
  video.ownerDocument = popoutEnv.document;
  popoutStage.appendChild(video);

  plugin.scan();

  // 1) Old main-document controller was replaced by a popout-document controller
  const popoutRoot = popoutStage.querySelector(".dsc-root");
  assert.ok(popoutRoot, "Fresh overlay mounted inside popout stage");
  assert.equal(popoutRoot.ownerDocument === popoutEnv.document, true, "Overlay elements belong to popout document");
  assert.ok(popoutEnv.document.getElementById("dsc-stream-cropper-styles"), "Stylesheet injected into popout <head>");
  assert.ok(popoutRoot.querySelector("style"), "Local fallback <style> embedded inside popout .dsc-root");

  // 2) Even if Discord's WindowPortal wipes `popoutEnv.document.head.innerHTML = ""`, styles are re-injected on scan AND embedded locally!
  popoutEnv.document.head.innerHTML = "";
  plugin.scan();
  assert.ok(popoutEnv.document.getElementById("dsc-stream-cropper-styles"), "Re-injected <head> stylesheet after WindowPortal wipe");

  plugin.stop();
});

test("11. Real-world Popout crop recall: channel header noise ('channel • streamer • ’s Screen'), 0x0 initial videoWidth, new stream wrapper & Popout -> Main roundtrip", () => {
  const mainEnv = createMockDOM({ withWebCodecs: true });
  // Simulate an Electron `about:blank` popout window that does NOT have its own WebCodecs constructors
  // while the main realm DOES — verifying main-realm WebCodecs constructors are used without cross-realm errors!
  const popoutEnv = createMockDOM({ withWebCodecs: false });

  const openPopouts = new Map([["DISCORD_STREAM_POPOUT", popoutEnv.window]]);

  // Wire PopoutWindowStore onto BdApi mock via constructor meta/api
  const bdStyles = new Map();
  const bdData = new Map();
  const customSandbox = {
    window: mainEnv.window,
    document: mainEnv.document,
    HTMLMediaElement: mainEnv.HTMLMediaElement,
    MutationObserver: mainEnv.window.MutationObserver,
    MediaStream: mainEnv.MediaStream,
    AbortController,
    AbortSignal,
    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    localStorage: mainEnv.localStorage,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    },
    clearInterval,
    console,
    ...mainEnv.webCodecsGlobals,
    module: { exports: {} },
    exports: {},
    BdApi: {
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
      Webpack: {
        getStore: (name) =>
          name === "PopoutWindowStore"
            ? {
                getWindowKeys: () => [...openPopouts.keys()],
                getWindow: (k) => openPopouts.get(k)
              }
            : null
      },
      Logger: { warn: () => {} }
    }
  };
  vm.runInNewContext(SOURCE, customSandbox, { filename: "StreamCropper.plugin.js" });
  const RealPlugin = customSandbox.module.exports;
  const plugin = new RealPlugin();
  plugin.start();

  // 1) Main window: watching a 1280x720 standard 16:9 stream (`streamer-one`) — note: vTrack.getSettings() omits width/height!
  const mainStage = mainEnv.document.createElement("div");
  mainStage.clientWidth = 1100;
  mainStage.clientHeight = 620;
  const mainBadge = mainEnv.document.createElement("span");
  mainBadge.textContent = "streamer-one";
  mainStage.appendChild(mainBadge);

  const mainVideo = mainEnv.document.createElement("video");
  const mainStream = Object.assign(
    new mainEnv.MediaStream([{ id: "webrtc-track-orig", kind: "video", getSettings: () => ({}) }]),
    { id: "webrtc-stream-orig" }
  );
  mainVideo.srcObject = mainStream;
  mainVideo.clientWidth = 1100;
  mainVideo.clientHeight = 620;
  mainVideo.videoWidth = 1280;
  mainVideo.videoHeight = 720;
  mainStage.appendChild(mainVideo);
  mainEnv.document.body.appendChild(mainStage);

  plugin.scan();

  // User crops `streamer-one` in Main Window to `left`
  const mainHud = mainStage.querySelector(".dsc-hud");
  const leftBtn = mainHud.querySelectorAll("button").find((b) => b.dataset.preset === "left");
  leftBtn.dispatchEvent(mainEnv.makeEvent("click"));
  assert.equal(RealPlugin.isCroppedStream(mainVideo.srcObject), true, "Cropped in main window");

  // 2) User clicks Discord's Pop Out button:
  // - Main `<video>` unmounts (`mainStage.remove()`)
  // - Popout window renders top titlebar: `<span>voice lobby</span><span>•</span><span>streamer-one</span><span>•</span><span>'s Screen</span><span>720p 60FPS</span><span>LIVE</span>`
  // - Popout `<video>` mounts with a NEW cloned MediaStream ID, `videoWidth = 0` initially (before first frame decodes), and DIFFERENT `clientWidth` (900x506)!
  mainStage.remove();

  const popoutShell = popoutEnv.document.createElement("div");
  popoutShell.clientWidth = 900;
  popoutShell.clientHeight = 560;

  const headerBar = popoutEnv.document.createElement("div");
  headerBar.clientWidth = 900;
  headerBar.clientHeight = 48;
  for (const token of ["voice lobby", "•", "streamer-one", "•", "'s Screen", "720p 60FPS", "LIVE"]) {
    const s = popoutEnv.document.createElement("span");
    s.textContent = token;
    headerBar.appendChild(s);
  }
  popoutShell.appendChild(headerBar);

  const popoutStage = popoutEnv.document.createElement("div");
  popoutStage.clientWidth = 900;
  popoutStage.clientHeight = 506;
  const popoutVideo = popoutEnv.document.createElement("video");
  const clonedPopoutStream = Object.assign(
    new mainEnv.MediaStream([{ id: "webrtc-track-cloned", kind: "video", getSettings: () => ({}) }]),
    { id: "webrtc-stream-cloned" }
  );
  popoutVideo.srcObject = clonedPopoutStream;
  popoutVideo.clientWidth = 900;
  popoutVideo.clientHeight = 506;
  popoutVideo.videoWidth = 0; // First frame hasn't decoded yet!
  popoutVideo.videoHeight = 0;

  popoutStage.appendChild(popoutVideo);
  popoutShell.appendChild(popoutStage);
  popoutEnv.document.body.appendChild(popoutShell);

  plugin.scan();

  // Popout MUST extract `"streamer-one"` (right before `'s Screen`, NOT `"voice lobby"`!)
  // and immediately restore the `left` crop using main-realm WebCodecs!
  const popoutController = plugin.controllers.get(popoutVideo);
  assert.ok(popoutController, "Mounted controller on popout video");
  assert.equal(RealPlugin.isCroppedStream(popoutVideo.srcObject), true, "Popout immediately remembered and applied crop!");
  assert.equal(popoutController.activePreset, "left", "Popout recalled exact 'left' preset");
  assert.equal(popoutController.cropSession.mode, "webcodecs", "Used main-realm WebCodecs cleanly inside about:blank popout");

  // 3) User changes crop to `right` INSIDE the Popout window, then closes the Popout back to Main Window!
  assert.equal(popoutController.host, popoutStage, "Mounted on popout video stage below titlebar (avoiding 720p 60FPS LIVE header overlap)");
  const popoutHud = popoutStage.querySelector(".dsc-hud");
  const rightBtn = popoutHud.querySelectorAll("button").find((b) => b.dataset.preset === "right");
  rightBtn.dispatchEvent(popoutEnv.makeEvent("click"));
  assert.equal(popoutController.activePreset, "right");

  openPopouts.clear();
  popoutEnv.window.closed = true;

  const returnedMainStage = mainEnv.document.createElement("div");
  returnedMainStage.clientWidth = 1100;
  returnedMainStage.clientHeight = 620;
  const returnedBadge = mainEnv.document.createElement("span");
  returnedBadge.textContent = "streamer-one";
  returnedMainStage.appendChild(returnedBadge);
  const returnedVideo = mainEnv.document.createElement("video");
  returnedVideo.srcObject = Object.assign(
    new mainEnv.MediaStream([{ id: "webrtc-track-return", kind: "video", getSettings: () => ({}) }]),
    { id: "webrtc-stream-return" }
  );
  returnedVideo.clientWidth = 1100;
  returnedVideo.clientHeight = 620;
  returnedVideo.videoWidth = 1280;
  returnedVideo.videoHeight = 720;
  returnedMainStage.appendChild(returnedVideo);
  mainEnv.document.body.appendChild(returnedMainStage);

  plugin.scan();

  const returnedController = plugin.controllers.get(returnedVideo);
  assert.equal(RealPlugin.isCroppedStream(returnedVideo.srcObject), true, "Main window remembered crop changed inside Popout");
  assert.equal(returnedController.activePreset, "right", "Main window recalled updated 'right' preset from Popout");

  plugin.stop();
});

test("12. Crop removal (Reset) persistence, legacy ultrawide-res purge, autoCenterUltrawide override, multi-streamer isolation, delayed audio addtrack & zero-thrash drag", async () => {
  const { env, PluginClass, bdData } = loadPlugin({ asBetterDiscord: true, withWebCodecs: true });

  // Pre-seed legacy `ultrawide-res:2560x720` entry in config (mirroring real-world upgraded configs!)
  bdData.set("StreamCropper:config", {
    settings: {
      buttonPosition: "top-right",
      rememberPerStreamer: true,
      autoCenterUltrawide: false,
      defaultSliceAspect: "16:9",
      showResolutionBadge: true
    },
    presets: [],
    rememberedCrops: [
      {
        key: "ultrawide-res:2560x720",
        region: { x: 0.25, y: 0, w: 0.5, h: 1 },
        preset: "center",
        updatedAt: Date.now() - 5000
      }
    ]
  });

  const plugin = new PluginClass();
  plugin.start();

  // 1) Mount streamer `alpha-uw` at 2560x720 where `vTrack.getSettings()` omits width/height
  const stageA = env.document.createElement("div");
  stageA.clientWidth = 1280;
  stageA.clientHeight = 720;
  const badgeA = env.document.createElement("span");
  badgeA.textContent = "alpha-uw";
  stageA.appendChild(badgeA);

  let trackA = null;
  const streamA = Object.assign(
    new env.MediaStream([
      {
        id: "alpha-track-1",
        kind: "video",
        getSettings: () => ({})
      }
    ]),
    { id: "alpha-stream-1" }
  );
  [trackA] = streamA.getVideoTracks();

  const videoA = env.document.createElement("video");
  videoA.srcObject = streamA;
  videoA.clientWidth = 1280;
  videoA.clientHeight = 720;
  videoA.videoWidth = 2560;
  videoA.videoHeight = 720;
  stageA.appendChild(videoA);
  env.document.body.appendChild(stageA);

  plugin.scan();
  assert.equal(PluginClass.isCroppedStream(videoA.srcObject), true, "Recalled pre-seeded legacy ultrawide-res:2560x720 crop");

  // Push a real 2560x720 frame through WebCodecs and simulate Chromium shrinking `video.videoWidth` to 1280 (cropped!)
  trackA._pushFrame(2560, 720, 1000);
  await new Promise((r) => setTimeout(r, 25));
  videoA.videoWidth = 1280; // Cropped output width!
  videoA.videoHeight = 720;

  // Also test Bug 14: Discord negotiates and adds screen-share audio track AFTER stream is already cropped!
  const lateAudioTrack = { id: "late-audio-1", kind: "audio" };
  streamA.addTrack(lateAudioTrack);
  streamA.dispatchEvent(env.makeEvent("addtrack", { track: lateAudioTrack }));
  assert.equal(videoA.srcObject.getAudioTracks().length, 1, "Delayed WebRTC audio track synced onto active cropped stream!");

  // 2) User clicks Reset while `videoA.videoWidth` is STILL 1280 (cropped) and HUD is closed (`sourceMonitorVideo === null`)!
  const resetBtn = stageA.querySelector(".dsc-reset-btn");
  resetBtn.dispatchEvent(env.makeEvent("click"));
  assert.equal(videoA.srcObject, streamA, "Restored original stream immediately");

  // Verify legacy `ultrawide-res:2560x720` was PURGED from saved config and `streamer:alpha-uw` has `isReset: true`!
  const savedAfterReset = bdData.get("StreamCropper:config");
  assert.equal(
    savedAfterReset.rememberedCrops.some((c) => c.key === "ultrawide-res:2560x720"),
    false,
    "Purged stale legacy ultrawide-res:2560x720 entry on Reset"
  );
  const alphaResetEntry = savedAfterReset.rememberedCrops.find((c) => c.key === "streamer:alpha-uw");
  assert.ok(alphaResetEntry?.isReset, "Saved explicit isReset tombstone for streamer:alpha-uw");

  // 3) Unmount `alpha-uw` and remount with a brand-new stream/track ID -> MUST stay uncropped (Reset remembered)!
  stageA.remove();
  plugin.scan();

  const stageA2 = env.document.createElement("div");
  stageA2.clientWidth = 1280;
  stageA2.clientHeight = 720;
  const badgeA2 = env.document.createElement("span");
  badgeA2.textContent = "alpha-uw";
  stageA2.appendChild(badgeA2);
  const videoA2 = env.document.createElement("video");
  const streamA2 = Object.assign(new env.MediaStream([{ id: "alpha-track-2", kind: "video", getSettings: () => ({ width: 2560, height: 720 }) }]), {
    id: "alpha-stream-2"
  });
  videoA2.srcObject = streamA2;
  videoA2.clientWidth = 1280;
  videoA2.clientHeight = 720;
  videoA2.videoWidth = 2560;
  videoA2.videoHeight = 720;
  stageA2.appendChild(videoA2);
  env.document.body.appendChild(stageA2);

  plugin.scan();
  assert.equal(videoA2.srcObject, streamA2, "Crop removal (Reset) remembered when returning to alpha-uw!");
  assert.equal(plugin.controllers.get(videoA2).activePreset, "full");

  // 4) Enable `autoCenterUltrawide = true`:
  // - `alpha-uw` (explicitly Reset earlier) MUST stay uncropped even when its badge renders 50ms AFTER `videoWidth`!
  // - `bravo-uw` (brand-new ultrawide streamer) MUST auto-center WITHOUT polluting `config.json`!
  stageA2.remove();
  plugin.scan();
  plugin.store.updateSetting("autoCenterUltrawide", true);

  const stageLateBadge = env.document.createElement("div");
  stageLateBadge.clientWidth = 1280;
  stageLateBadge.clientHeight = 720;
  const videoLate = env.document.createElement("video");
  const streamLate = Object.assign(new env.MediaStream([{ id: "alpha-track-3", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]), {
    id: "alpha-stream-3"
  });
  videoLate.srcObject = streamLate;
  videoLate.clientWidth = 1280;
  videoLate.clientHeight = 720;
  videoLate.videoWidth = 5120;
  videoLate.videoHeight = 1440;
  stageLateBadge.appendChild(videoLate);
  env.document.body.appendChild(stageLateBadge);

  plugin.scan(); // Tentatively auto-centers before badge arrives
  assert.equal(PluginClass.isCroppedStream(videoLate.srcObject), true, "Tentatively auto-centered before streamer badge mounted");

  // Now Discord mounts the `alpha-uw` badge! Next scan/mutation recalls `alpha-uw`'s explicit Reset and un-crops!
  const lateSpan = env.document.createElement("span");
  lateSpan.textContent = "alpha-uw";
  stageLateBadge.appendChild(lateSpan);
  plugin.scan();
  assert.equal(videoLate.srcObject, streamLate, "Late-arriving streamer badge recalled explicit Reset and overrode autoCenterUltrawide!");

  // Mount brand-new `bravo-uw`: auto-centers, but does NOT write fake manual crop to disk!
  stageLateBadge.remove();
  plugin.scan();

  const stageBravo = env.document.createElement("div");
  stageBravo.clientWidth = 1280;
  stageBravo.clientHeight = 720;
  const badgeBravo = env.document.createElement("span");
  badgeBravo.textContent = "bravo-uw";
  stageBravo.appendChild(badgeBravo);
  const videoBravo = env.document.createElement("video");
  videoBravo.srcObject = Object.assign(new env.MediaStream([{ id: "bravo-track-1", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]), {
    id: "bravo-stream-1"
  });
  videoBravo.clientWidth = 1280;
  videoBravo.clientHeight = 720;
  videoBravo.videoWidth = 5120;
  videoBravo.videoHeight = 1440;
  stageBravo.appendChild(videoBravo);
  env.document.body.appendChild(stageBravo);

  plugin.scan();
  assert.equal(PluginClass.isCroppedStream(videoBravo.srcObject), true, "New ultrawide streamer bravo-uw auto-centered");
  assert.equal(
    bdData.get("StreamCropper:config").rememberedCrops.some((c) => c.key.includes("bravo-uw")),
    false,
    "autoCenterUltrawide did NOT write fake manual crop entry to persistent disk storage"
  );

  // 5) Multi-streamer isolation: manually crop `bravo-uw` to `left`, verify `alpha-uw` STILL remembers its `Reset`,
  // and resetting `alpha-uw` does NOT wipe `bravo-uw`'s `left` crop!
  plugin.store.updateSetting("autoCenterUltrawide", false);
  const bravoHud = stageBravo.querySelector(".dsc-hud");
  bravoHud.querySelectorAll("button").find((b) => b.dataset.preset === "left").dispatchEvent(env.makeEvent("click"));

  // Also test Bug 11: Minimap drag `mousemove` causes ZERO synchronous disk writes until `mouseup`!
  const bravoTrigger = stageBravo.querySelector(".dsc-trigger");
  bravoTrigger.dispatchEvent(env.makeEvent("click"));
  const minimap = stageBravo.querySelector(".dsc-minimap");
  minimap._rect = { left: 0, top: 0, width: 312, height: 90 };
  const minimapBox = stageBravo.querySelector(".dsc-minimap-box");

  let saveCount = 0;
  const origSave = plugin.api.Data.save;
  plugin.api.Data.save = (k, v) => {
    saveCount++;
    return origSave(k, v);
  };

  minimap.dispatchEvent(env.makeEvent("mousedown", { button: 0, clientX: 40, clientY: 45, target: minimapBox }));
  env.window.dispatchEvent(env.makeEvent("mousemove", { clientX: 60, clientY: 45 }));
  env.window.dispatchEvent(env.makeEvent("mousemove", { clientX: 80, clientY: 45 }));
  env.window.dispatchEvent(env.makeEvent("mousemove", { clientX: 100, clientY: 45 }));
  assert.equal(saveCount, 0, "Zero synchronous BdApi.Data.save disk writes during minimap mousemove!");
  env.window.dispatchEvent(env.makeEvent("mouseup", { clientX: 100, clientY: 45 }));
  assert.equal(saveCount, 1, "Persisted once cleanly on mouseup!");

  // Switch back to `alpha-uw` -> still uncropped! Switch back to `bravo-uw` -> still cropped!
  stageBravo.remove();
  plugin.scan();

  const stageAlphaCheck = env.document.createElement("div");
  stageAlphaCheck.clientWidth = 1280;
  stageAlphaCheck.clientHeight = 720;
  const spanAlphaCheck = env.document.createElement("span");
  spanAlphaCheck.textContent = "alpha-uw";
  stageAlphaCheck.appendChild(spanAlphaCheck);
  const vidAlphaCheck = env.document.createElement("video");
  const rawAlphaCheck = new env.MediaStream([{ id: "alpha-track-4", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]);
  vidAlphaCheck.srcObject = rawAlphaCheck;
  vidAlphaCheck.clientWidth = 1280;
  vidAlphaCheck.clientHeight = 720;
  vidAlphaCheck.videoWidth = 5120;
  vidAlphaCheck.videoHeight = 1440;
  stageAlphaCheck.appendChild(vidAlphaCheck);
  env.document.body.appendChild(stageAlphaCheck);

  plugin.scan();
  assert.equal(vidAlphaCheck.srcObject, rawAlphaCheck, "bravo-uw's crop did NOT override alpha-uw's Reset tombstone!");

  stageAlphaCheck.remove();
  const stageBravoCheck = env.document.createElement("div");
  stageBravoCheck.clientWidth = 1280;
  stageBravoCheck.clientHeight = 720;
  const spanBravoCheck = env.document.createElement("span");
  spanBravoCheck.textContent = "bravo-uw";
  stageBravoCheck.appendChild(spanBravoCheck);
  const vidBravoCheck = env.document.createElement("video");
  vidBravoCheck.srcObject = new env.MediaStream([{ id: "bravo-track-2", kind: "video", getSettings: () => ({ width: 5120, height: 1440 }) }]);
  vidBravoCheck.clientWidth = 1280;
  vidBravoCheck.clientHeight = 720;
  vidBravoCheck.videoWidth = 5120;
  vidBravoCheck.videoHeight = 1440;
  stageBravoCheck.appendChild(vidBravoCheck);
  env.document.body.appendChild(stageBravoCheck);

  plugin.scan();
  assert.equal(PluginClass.isCroppedStream(vidBravoCheck.srcObject), true, "bravo-uw retained its custom crop independently!");

  plugin.stop();
});

test("13. Deep audit regressions: zero-reset srcObject hook, CropStore tail slice, audio-first/ended tracks, cross-streamer & handoff isolation, Escape in Fullscreen HUD, settings reactivity, mid-drag abort & standalone mode", async () => {
  // A) Standalone non-BetterDiscord fallback mode (`asBetterDiscord: false`) works without global `BdApi`
  const standalone = loadPlugin({ asBetterDiscord: false, withWebCodecs: true });
  assert.equal(typeof standalone.PluginClass, "function", "Exports window.DiscordStreamCropper when CommonJS module is absent");
  const standaloneInstance = new standalone.PluginClass();
  standaloneInstance.start();
  assert.ok(standalone.env.document.getElementById("dsc-stream-cropper-styles"), "Fallback DOM style injection works without BdApi");
  standaloneInstance.stop();
  assert.equal(standalone.env.document.getElementById("dsc-stream-cropper-styles"), null);

  // B) CropStore constructor keeps the NEWEST presets & rememberedCrops (`.slice(-MAX)` instead of `.slice(0, MAX)`)
  const popoutWindows = new Map();
  const { env, PluginClass, bdData } = loadPlugin({
    asBetterDiscord: true,
    withWebCodecs: true,
    popoutWindows
  });

  const manyPresets = Array.from({ length: 9 }, (_, i) => ({
    name: `Preset ${i + 1}`,
    region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
  }));
  const manyRemembered = Array.from({ length: 105 }, (_, i) => ({
    key: `streamer:user-${i + 1}`,
    region: { x: 0.25, y: 0, w: 0.5, h: 1 },
    preset: "center",
    updatedAt: i + 1
  }));
  bdData.set("StreamCropper:config", {
    settings: { rememberPerStreamer: true, autoCenterUltrawide: false },
    presets: manyPresets,
    rememberedCrops: manyRemembered
  });

  const plugin = new PluginClass();
  assert.equal(plugin.savedPresets.length, 6);
  assert.equal(plugin.savedPresets[5].name, "Preset 9", "Kept newest saved presets on reload");
  assert.equal(plugin.savedPresets[0].name, "Preset 4", "Dropped oldest overflow presets");
  const recalledNewest = plugin.recallStreamCrop({
    sessionKeys: [],
    streamerKeys: ["streamer:user-105"],
    fallbackKeys: [],
    persistentKeys: ["streamer:user-105"]
  });
  assert.ok(recalledNewest && !recalledNewest.isReset, "Kept newest remembered crop #105 on reload");

  // Clear presets to test collision-free auto-naming (`Crop 1`, `Crop 2`, delete `Crop 1` -> next is `Crop 1`, not duplicate `Crop 2`!)
  while (plugin.savedPresets.length) plugin.deletePreset(0);
  plugin.start();

  // C) Redundant React `video.srcObject = originalStream` re-renders do NOT re-invoke native `srcObject` setter when cropped stream is already attached
  let nativeSrcSetCount = 0;
  const origDesc = Object.getOwnPropertyDescriptor(env.HTMLMediaElement.prototype, "srcObject");
  Object.defineProperty(env.HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    enumerable: true,
    get: origDesc.get,
    set(val) {
      if (this.tagName === "VIDEO" && !this.dataset?.dscInternal) {
        nativeSrcSetCount++;
      }
      origDesc.set.call(this, val);
    }
  });

  // D) Ended track at index 0 + live track at index 1, AND possessive `' Screen` header (`Chris' Screen`) + noise filtering (`120 FPS`, `AV1`)
  const endedTrack = { id: "dead-track-0", kind: "video", readyState: "ended", getSettings: () => ({ width: 1920, height: 1080 }) };
  const liveTrack = { id: "live-track-1", kind: "video", readyState: "live", getSettings: () => ({ width: 5120, height: 1440 }) };
  const streamChris = Object.assign(new env.MediaStream([endedTrack, liveTrack]), { id: "chris-stream" });

  const shellChris = env.document.createElement("div");
  shellChris.clientWidth = 1600;
  shellChris.clientHeight = 940;
  const headerChris = env.document.createElement("div");
  headerChris.clientWidth = 1600;
  headerChris.clientHeight = 40;
  const headerTitle = env.document.createElement("span");
  headerTitle.textContent = "Gaming Lobby • Chris' Screen";
  headerChris.appendChild(headerTitle);
  shellChris.appendChild(headerChris);

  const stageChris = env.document.createElement("div");
  stageChris.clientWidth = 1600;
  stageChris.clientHeight = 900;
  for (const noise of ["120 FPS", "AV1", "Click to unmute", "Valorant"]) {
    const pill = env.document.createElement("span");
    pill.textContent = noise;
    stageChris.appendChild(pill);
  }
  const videoChris = env.document.createElement("video");
  videoChris.srcObject = streamChris;
  videoChris.clientWidth = 1600;
  videoChris.clientHeight = 450;
  videoChris.videoWidth = 5120;
  videoChris.videoHeight = 1440;
  stageChris.appendChild(videoChris);
  shellChris.appendChild(stageChris);
  env.document.body.appendChild(shellChris);

  plugin.scan();
  const ctrlChris = plugin.controllers.get(videoChris);
  assert.ok(ctrlChris, "Mounted controller on Chris's stage");

  // Open HUD, crop to Center: selects `liveTrack` (index 1), skips `endedTrack` (index 0), and uses WebCodecs!
  const triggerChris = stageChris.querySelector(".dsc-trigger");
  triggerChris.dispatchEvent(env.makeEvent("click"));
  assert.equal(ctrlChris.isOpen, true);
  stageChris.querySelectorAll("button").find((b) => b.dataset.preset === "center").dispatchEvent(env.makeEvent("click"));
  assert.equal(ctrlChris.cropSession.mode, "webcodecs", "Selected live video track #1 instead of throwing on ended track #0");

  const setCountAfterCrop = nativeSrcSetCount;
  // Simulate 5 Discord React re-renders setting `videoChris.srcObject = streamChris`
  for (let r = 0; r < 5; r++) {
    videoChris.srcObject = streamChris;
  }
  assert.equal(nativeSrcSetCount, setCountAfterCrop, "Zero redundant native srcObject resets across React re-renders!");

  // Verify cross-streamer isolation: `"Chris' Screen"` header extracted ONLY `"chris"`, NOT `"valorant"` or `"120 fps"`!
  const savedKeys = bdData.get("StreamCropper:config").rememberedCrops.map((c) => c.key);
  assert.ok(savedKeys.includes("streamer:chris"), "Extracted possessive header name ending in s ('Chris\\' Screen' -> 'chris')");
  assert.ok(savedKeys.includes("streamer:chris|5120x1440"));
  assert.equal(savedKeys.some((k) => k.includes("valorant") || k.includes("120 fps") || k.includes("av1")), false, "Did not cross-pollute streamerKeys with game/FPS pills!");
  // Resolution-specific key sits AFTER generic key so exact resolution wins on recall
  assert.ok(
    savedKeys.indexOf("streamer:chris|5120x1440") > savedKeys.indexOf("streamer:chris"),
    "Resolution-specific key stored after generic key so exact WxH match wins"
  );

  // E) Pressing `Escape` while HUD is open inside Fullscreen closes HUD, restores focus to trigger, and stops propagation before exiting Fullscreen!
  env.document.fullscreenElement = stageChris;
  let fullscreenExited = false;
  const externalFsListener = (e) => {
    if (e.key === "Escape") fullscreenExited = true;
  };
  env.window.addEventListener("keydown", externalFsListener, { capture: true });
  const escHudEvent = env.makeEvent("keydown", { key: "Escape" });
  stageChris.dispatchEvent(escHudEvent);
  env.window.removeEventListener("keydown", externalFsListener, { capture: true });
  env.document.fullscreenElement = null;

  assert.equal(ctrlChris.isOpen, false, "Escape closed open HUD");
  assert.equal(escHudEvent.defaultPrevented, true, "Escape preventDefault() called when closing open HUD");
  assert.equal(fullscreenExited, false, "stopImmediatePropagation prevented Fullscreen exit on Escape");
  assert.equal(env.document.activeElement, triggerChris, "Focus restored to Crop trigger button");

  // F) Minimap `mousedown` focuses minimap despite `preventDefault()`, preset auto-naming avoids collisions, and wheel/keydown debounce disk writes
  triggerChris.dispatchEvent(env.makeEvent("click"));
  const minimap = stageChris.querySelector(".dsc-minimap");
  minimap._rect = { left: 0, top: 0, width: 312, height: 90 };
  const minimapBox = stageChris.querySelector(".dsc-minimap-box");
  minimap.dispatchEvent(env.makeEvent("mousedown", { button: 0, clientX: 150, clientY: 45, target: minimapBox }));
  assert.equal(env.document.activeElement, minimap, "Clicking minimap explicitly focuses it for keyboard arrow nudging");
  env.window.dispatchEvent(env.makeEvent("mouseup", { clientX: 150, clientY: 45 }));

  // Nudge to custom region & save 2 presets -> delete first -> save another -> no collision!
  let wheelSaves = 0;
  const rawSave = plugin.api.Data.save;
  plugin.api.Data.save = (k, v) => {
    wheelSaves++;
    return rawSave(k, v);
  };
  minimap.dispatchEvent(env.makeEvent("keydown", { key: "ArrowLeft" }));
  minimap.dispatchEvent(env.makeEvent("keydown", { key: "ArrowLeft" }));
  minimap.dispatchEvent(env.makeEvent("wheel", { deltaY: -100 }));
  assert.equal(wheelSaves, 0, "Rapid wheel/keydown nudges debounced without synchronous disk thrashing");
  plugin.store.flushPendingSave();
  assert.equal(wheelSaves, 1, "Debounced wheel/keydown updates flushed in a single disk write");

  const saveBtn = stageChris.querySelector(".dsc-save-btn");
  saveBtn.dispatchEvent(env.makeEvent("click")); // Crop 1
  minimap.dispatchEvent(env.makeEvent("keydown", { key: "ArrowRight" }));
  saveBtn.dispatchEvent(env.makeEvent("click")); // Crop 2
  assert.deepEqual(plugin.savedPresets.map((p) => p.name), ["Crop 1", "Crop 2"]);
  plugin.deletePreset(0); // Deletes "Crop 1", leaving ["Crop 2"] (`length === 1`)
  minimap.dispatchEvent(env.makeEvent("keydown", { key: "ArrowRight" }));
  saveBtn.dispatchEvent(env.makeEvent("click")); // Must pick unused "Crop 1", NOT overwrite "Crop 2"!
  assert.equal(plugin.savedPresets.length, 2, "Did not overwrite 'Crop 2' after deleting 'Crop 1'");

  // G) Settings live reactivity: changing `defaultSliceAspect` updates active `center` slice immediately!
  stageChris.querySelectorAll("button").find((b) => b.dataset.preset === "center").dispatchEvent(env.makeEvent("click"));
  const widthAt16x9 = ctrlChris.region.w;
  const settingsSpec = plugin.getSettingsPanel();
  settingsSpec.onChange(null, "defaultSliceAspect", "21:9");
  assert.ok(ctrlChris.region.w > widthAt16x9 + 0.1, "Changing defaultSliceAspect live-recomputed active Center crop region");
  settingsSpec.onChange(null, "defaultSliceAspect", "16:9");

  // H) Async WebCodecs fallback picks up audio tracks added AFTER `start()` (not stale t=0 snapshot)
  const lateStreamAudio = { id: "late-wc-audio", kind: "audio" };
  streamChris.addTrack(lateStreamAudio);
  streamChris.dispatchEvent(env.makeEvent("addtrack", { track: lateStreamAudio }));
  liveTrack._failStream(new Error("Simulated decoder reset"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctrlChris.cropSession.mode, "canvas", "Switched to canvas fallback");
  assert.equal(videoChris.srcObject.getAudioTracks().includes(lateStreamAudio), true, "Canvas fallback preserved late-arriving audio track!");

  // I) `#recentHandoff` does NOT leak `chris`'s crop onto a DIFFERENT streamer's unbadged/loading Popout!
  shellChris.remove();
  plugin.scan(); // Records handoff for `streamer: "chris"` (`sourceIsPopout: false`)

  const popoutOtherEnv = createMockDOM({ withWebCodecs: true });
  popoutWindows.set("OTHER_POPOUT", popoutOtherEnv.window);
  const popoutOtherStage = popoutOtherEnv.document.createElement("div");
  popoutOtherStage.clientWidth = 1280;
  popoutOtherStage.clientHeight = 720;
  const popoutOtherVideo = popoutOtherEnv.document.createElement("video");
  const otherRawStream = Object.assign(new popoutOtherEnv.MediaStream([{ id: "other-track", kind: "video", readyState: "live" }]), {
    id: "other-stream"
  });
  popoutOtherVideo.srcObject = otherRawStream;
  popoutOtherVideo.clientWidth = 1280;
  popoutOtherVideo.clientHeight = 720;
  popoutOtherVideo.videoWidth = 0; // Unbadged & 0x0 before metadata loads!
  popoutOtherVideo.videoHeight = 0;
  popoutOtherStage.appendChild(popoutOtherVideo);
  popoutOtherEnv.document.body.appendChild(popoutOtherStage);

  plugin.scan();
  assert.equal(popoutOtherVideo.srcObject, otherRawStream, "Did NOT leak Chris's crop onto a different streamer's loading popout!");
  popoutWindows.clear();
  popoutOtherEnv.window.closed = true;
  plugin.scan();

  // J) Audio-first WebRTC stream (`0` initial video tracks) followed by delayed `addtrack` (`kind: "video"`) + standalone 16:9 mini-player eligibility!
  const miniHost16x9 = env.document.createElement("div");
  miniHost16x9.clientWidth = 240;
  miniHost16x9.clientHeight = 135;
  const miniBadge = env.document.createElement("span");
  miniBadge.textContent = "chris";
  miniHost16x9.appendChild(miniBadge);

  const audioOnlyFirstStream = Object.assign(new env.MediaStream([{ id: "a-first", kind: "audio", readyState: "live" }]), {
    id: "chris-audio-first"
  });
  const miniVid = env.document.createElement("video");
  miniVid.srcObject = audioOnlyFirstStream;
  miniVid.clientWidth = 240;
  miniVid.clientHeight = 135;
  miniHost16x9.appendChild(miniVid);
  env.document.body.appendChild(miniHost16x9);

  plugin.scan();
  const miniCtrl = plugin.controllers.get(miniVid);
  assert.ok(miniCtrl, "Standalone 240x135 mini-player mounted controller");
  assert.equal(miniVid.srcObject, audioOnlyFirstStream, "Attached raw stream cleanly while awaiting delayed video track");

  // Now WebRTC negotiates the video track via `addtrack` -> automatically builds WebCodecs crop session!
  const delayedVidTrack = { id: "v-delayed", kind: "video", readyState: "live", getSettings: () => ({ width: 5120, height: 1440 }) };
  audioOnlyFirstStream.addTrack(delayedVidTrack);
  audioOnlyFirstStream.dispatchEvent(env.makeEvent("addtrack", { track: delayedVidTrack }));
  assert.equal(PluginClass.isCroppedStream(miniVid.srcObject), true, "Delayed video addtrack automatically activated recalled crop!");
  miniHost16x9.remove();
  plugin.scan();

  // K) `autoCenterUltrawide` mid-stream aspect shift: 32:9 -> 16:9 auto-reverts to full stream!
  settingsSpec.onChange(null, "autoCenterUltrawide", true);
  const shiftStage = env.document.createElement("div");
  shiftStage.clientWidth = 1280;
  shiftStage.clientHeight = 720;
  const shiftBadge = env.document.createElement("span");
  shiftBadge.textContent = "dynamic-streamer";
  shiftStage.appendChild(shiftBadge);
  let dynamicDims = { width: 5120, height: 1440 };
  const shiftTrack = { id: "shift-track", kind: "video", readyState: "live", getSettings: () => ({ ...dynamicDims }) };
  const shiftRaw = new env.MediaStream([shiftTrack]);
  const shiftVideo = env.document.createElement("video");
  shiftVideo.srcObject = shiftRaw;
  shiftVideo.clientWidth = 1280;
  shiftVideo.clientHeight = 720;
  shiftVideo.videoWidth = 5120;
  shiftVideo.videoHeight = 1440;
  shiftStage.appendChild(shiftVideo);
  env.document.body.appendChild(shiftStage);

  plugin.scan();
  assert.equal(PluginClass.isCroppedStream(shiftVideo.srcObject), true, "Auto-centered 32:9 stream");

  // Streamer switches screen share from 32:9 monitor to a 1920x1080 game window on the same track!
  dynamicDims = { width: 1920, height: 1080 };
  shiftTrack._pushFrame(1920, 1080, 5000);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(shiftVideo.srcObject, shiftRaw, "Auto-reverted auto-center when streamer switched from 32:9 to 16:9 mid-stream!");

  // L) Mid-drag controller teardown aborts window drag listeners cleanly (no zombie sessions or post-stop saves)
  const dragCtrl = plugin.controllers.get(shiftVideo);
  const dragTrigger = shiftStage.querySelector(".dsc-trigger");
  dragTrigger.dispatchEvent(env.makeEvent("click"));
  const dragMinimap = shiftStage.querySelector(".dsc-minimap");
  dragMinimap._rect = { left: 0, top: 0, width: 312, height: 176 };
  dragMinimap.dispatchEvent(env.makeEvent("mousedown", { button: 0, clientX: 20, clientY: 20, target: dragMinimap }));

  plugin.stop();
  let savesAfterStop = 0;
  plugin.api.Data.save = () => {
    savesAfterStop++;
  };
  env.window.dispatchEvent(env.makeEvent("mousemove", { clientX: 220, clientY: 140 }));
  env.window.dispatchEvent(env.makeEvent("mouseup", { clientX: 220, clientY: 140 }));
  assert.equal(dragCtrl.cropSession, null, "No zombie cropSession spawned by mousemove after plugin.stop()");
  assert.equal(savesAfterStop, 0, "No post-stop disk writes from mid-drag mouseup");

  // Restore prototype descriptor
  Object.defineProperty(env.HTMLMediaElement.prototype, "srcObject", origDesc);
});
