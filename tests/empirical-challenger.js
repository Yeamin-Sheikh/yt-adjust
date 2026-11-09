// =============================================================================
// Empirical Stress Test Suite for Milestone 1 - Challenger 2
// Tests:
// 1. DOM reparenting and placeholder mechanics under missing or reordered nodes
// 2. Web Audio API initialization, single-attachment caching, AudioContext resume
// 3. TrustedHTML Content Security Policy compliance
// 4. YouTube player method null guards
// =============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

console.log("Starting Challenger 2 Empirical Stress Test Suite...\n");

// Read target source files
const mainJsPath = path.resolve(__dirname, "../content/main.js");
const isolatedJsPath = path.resolve(__dirname, "../content/isolated.js");
const popupJsPath = path.resolve(__dirname, "../popup/popup.js");

const mainJsCode = fs.readFileSync(mainJsPath, "utf8");
const isolatedJsCode = fs.readFileSync(isolatedJsPath, "utf8");
const popupJsCode = fs.readFileSync(popupJsPath, "utf8");

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

// -----------------------------------------------------------------------------
// Minimal DOM Mock supporting full content/main.js execution
// -----------------------------------------------------------------------------
function createDomEnvironment(options = {}) {
  const elements = new Map();
  const eventListeners = new Map();

  class MockNode {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.nodeName = this.tagName;
      this.nodeType = 1;
      this.children = [];
      this.childNodes = this.children;
      this.parentElement = null;
      this.parentNode = null;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.id = "";
      this.className = "";
      const self = this;
      this.classList = {
        add(...cls) {
          const current = self.className.split(/\s+/).filter(Boolean);
          for (const c of cls) if (!current.includes(c)) current.push(c);
          self.className = current.join(" ");
        },
        remove(...cls) {
          const current = self.className.split(/\s+/).filter(Boolean);
          self.className = current.filter((c) => !cls.includes(c)).join(" ");
        },
        contains(c) {
          return self.className.split(/\s+/).includes(c);
        },
      };
      this._textContent = "";
      this.title = "";
      this.listeners = new Map();
      this.isConnected = true;
    }

    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => c.textContent).join(" ");
      }
      return this._textContent || "";
    }

    set textContent(val) {
      this._textContent = String(val);
    }

    click() {
      this.dispatchEvent({ type: "click" });
      if (typeof this.onclick === "function") {
        this.onclick({ type: "click" });
      }
    }

    get nextSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      if (idx === -1 || idx === this.parentElement.children.length - 1) return null;
      return this.parentElement.children[idx + 1];
    }

    get previousSibling() {
      if (!this.parentElement) return null;
      const idx = this.parentElement.children.indexOf(this);
      if (idx <= 0) return null;
      return this.parentElement.children[idx - 1];
    }

    appendChild(child) {
      if (!child) throw new TypeError("child is null");
      if (child.parentElement) {
        child.parentElement.removeChild(child);
      }
      child.parentElement = this;
      child.parentNode = this;
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      return child;
    }

    insertBefore(newNode, referenceNode) {
      if (!newNode) throw new TypeError("newNode is null");
      if (!referenceNode) return this.appendChild(newNode);
      const idx = this.children.indexOf(referenceNode);
      if (idx === -1) {
        throw new Error("NotFoundError: The node before which the new node is to be inserted is not a child of this node.");
      }
      if (newNode.parentElement) {
        newNode.parentElement.removeChild(newNode);
      }
      newNode.parentElement = this;
      newNode.parentNode = this;
      this.children.splice(idx, 0, newNode);
      if (newNode.id) elements.set(newNode.id, newNode);
      return newNode;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx === -1) {
        throw new Error("NotFoundError: The node to be removed is not a child of this node.");
      }
      this.children.splice(idx, 1);
      child.parentElement = null;
      child.parentNode = null;
      return child;
    }

    remove() {
      if (this.parentElement) {
        this.parentElement.removeChild(this);
      }
    }

    setAttribute(key, val) {
      this.attributes.set(key, String(val));
      if (key === "id") {
        this.id = String(val);
        elements.set(this.id, this);
      }
      if (key === "class") this.className = String(val);
    }

    getAttribute(key) {
      return this.attributes.get(key) || null;
    }

    removeAttribute(key) {
      this.attributes.delete(key);
      if (key === "id") this.id = "";
      if (key === "class") this.className = "";
    }

    addEventListener(type, listener, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push({ listener, options });
    }

    removeEventListener(type, listener) {
      if (!this.listeners.has(type)) return;
      const list = this.listeners.get(type);
      const idx = list.findIndex((item) => item.listener === listener);
      if (idx !== -1) list.splice(idx, 1);
    }

    dispatchEvent(event) {
      const list = this.listeners.get(event.type) || [];
      for (const item of list) {
        item.listener(event);
      }
    }

    querySelector(selector) {
      const parts = selector.split(",").map((s) => s.trim());
      const search = (node) => {
        for (const c of node.children) {
          const match = parts.some((p) => {
            if (p.startsWith("#") && c.id === p.slice(1)) return true;
            if (p.startsWith(".") && c.className && c.className.split(/\s+/).includes(p.slice(1))) return true;
            if (c.tagName.toLowerCase() === p.toLowerCase()) return true;
            return false;
          });
          if (match) return c;
          const found = search(c);
          if (found) return found;
        }
        return null;
      };
      return search(this);
    }

    querySelectorAll(selector) {
      const results = [];
      const parts = selector.split(",").map((s) => s.trim());
      const search = (node) => {
        for (const c of node.children) {
          const match = parts.some((p) => {
            if (p.startsWith("#") && c.id === p.slice(1)) return true;
            if (p.startsWith(".") && c.className && c.className.split(/\s+/).includes(p.slice(1))) return true;
            if (c.tagName.toLowerCase() === p.toLowerCase()) return true;
            return false;
          });
          if (match && !results.includes(c)) results.push(c);
          search(c);
        }
      };
      search(this);
      return results;
    }

    closest(selector) {
      const parts = selector.split(",").map((s) => s.trim());
      let curr = this;
      while (curr) {
        const match = parts.some((p) => {
          if (p.startsWith("#") && curr.id === p.slice(1)) return true;
          if (p.startsWith(".") && curr.className && curr.className.split(/\s+/).includes(p.slice(1))) return true;
          if (curr.tagName && curr.tagName.toLowerCase() === p.toLowerCase()) return true;
          return false;
        });
        if (match) return curr;
        curr = curr.parentElement;
      }
      return null;
    }

    contains(node) {
      let curr = node;
      while (curr) {
        if (curr === this) return true;
        curr = curr.parentElement;
      }
      return false;
    }

    getBoundingClientRect() {
      return {
        top: 0,
        bottom: options.playerBottom !== undefined ? options.playerBottom : 100,
        left: 0,
        right: 1280,
        width: 1280,
        height: 720,
      };
    }

    // TrustedHTML CSP Enforcement:
    // If strictCsp is enabled, any attempt to set innerHTML or outerHTML throws TypeError
    get innerHTML() {
      return "";
    }
    set innerHTML(val) {
      if (options.strictCsp) {
        throw new TypeError("Failed to set the 'innerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
      }
      this.textContent = val;
    }

    get outerHTML() {
      return "";
    }
    set outerHTML(val) {
      if (options.strictCsp) {
        throw new TypeError("Failed to set the 'outerHTML' property on 'Element': This document requires 'TrustedHTML' assignment.");
      }
    }

    insertAdjacentHTML(position, text) {
      if (options.strictCsp) {
        throw new TypeError("Failed to execute 'insertAdjacentHTML' on 'Element': This document requires 'TrustedHTML' assignment.");
      }
    }
  }

  const documentElement = new MockNode("html");
  const head = new MockNode("head");
  const body = new MockNode("body");
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const documentMock = {
    head,
    body,
    documentElement,
    activeElement: null,
    fullscreenElement: options.fullscreenElement ? new MockNode("div") : null,
    createElement(tag) {
      const el = new MockNode(tag);
      return el;
    },
    createElementNS(ns, tag) {
      const el = new MockNode(tag);
      el.namespaceURI = ns;
      return el;
    },
    getElementById(id) {
      const el = elements.get(id);
      if (!el) return null;
      let curr = el;
      while (curr && curr !== documentElement) {
        curr = curr.parentElement;
      }
      return curr === documentElement ? el : null;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) {
        return elements.get(selector.slice(1)) || null;
      }
      return body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    addEventListener(type, listener, opts) {
      if (!eventListeners.has(type)) eventListeners.set(type, []);
      eventListeners.get(type).push({ listener, opts });
    },
    removeEventListener(type, listener) {
      if (!eventListeners.has(type)) return;
      const list = eventListeners.get(type);
      const idx = list.findIndex((item) => item.listener === listener);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = eventListeners.get(event.type) || [];
      for (const item of list) {
        item.listener(event);
      }
    },
  };

  // Mock AudioContext and nodes
  let createSourceCallCount = 0;
  const connectedMediaElements = new Set();

  class MockAudioNode {
    constructor() {
      this.connectedTo = null;
    }
    connect(dest) {
      this.connectedTo = dest;
    }
  }

  class MockGainNode extends MockAudioNode {
    constructor() {
      super();
      this.gain = { value: 1.0 };
    }
  }

  class MockMediaElementAudioSourceNode extends MockAudioNode {
    constructor(mediaElement) {
      super();
      this.mediaElement = mediaElement;
    }
  }

  class MockAudioContext {
    constructor() {
      this.state = options.initialAudioState || "suspended";
      this.destination = new MockAudioNode();
      this.resumeCallCount = 0;
    }

    createGain() {
      return new MockGainNode();
    }

    createMediaElementSource(mediaElement) {
      createSourceCallCount++;
      // According to W3C Web Audio API specification:
      // "createMediaElementSource: HTMLMediaElement already connected previously to a different MediaElementSourceNode throws InvalidStateError"
      if (connectedMediaElements.has(mediaElement)) {
        throw new Error("InvalidStateError: HTMLMediaElement already connected previously to a different MediaElementSourceNode");
      }
      connectedMediaElements.add(mediaElement);
      return new MockMediaElementAudioSourceNode(mediaElement);
    }

    async resume() {
      this.resumeCallCount++;
      if (options.audioResumeRejects) {
        throw new Error("AudioContext resume rejected by user gesture policy");
      }
      this.state = "running";
    }
  }

  const localStorageStore = new Map();
  const localStorageMock = {
    getItem(k) { return localStorageStore.get(k) || null; },
    setItem(k, v) { localStorageStore.set(k, String(v)); },
    removeItem(k) { localStorageStore.delete(k); },
    clear() { localStorageStore.clear(); },
  };

  const windowMock = {
    document: documentMock,
    location: {
      pathname: "/watch",
      search: "?v=dQw4w9WgXcQ",
      origin: "https://www.youtube.com",
    },
    AudioContext: MockAudioContext,
    webkitAudioContext: MockAudioContext,
    localStorage: localStorageMock,
    addEventListener(type, listener) {
      documentMock.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      documentMock.removeEventListener(type, listener);
    },
    dispatchEvent(event) {
      documentMock.dispatchEvent(event);
    },
    postMessage(data, targetOrigin) {},
    requestAnimationFrame(cb) { return setTimeout(cb, 16); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Node: MockNode,
    Element: MockNode,
    HTMLElement: MockNode,
    HTMLVideoElement: MockNode,
    console,
  };

  return {
    window: windowMock,
    document: documentMock,
    elements,
    eventListeners,
    getCreateSourceCallCount: () => createSourceCallCount,
    connectedMediaElements,
  };
}

// -----------------------------------------------------------------------------
// Test Runner using VM context for content/main.js
// -----------------------------------------------------------------------------
function loadMainJsInContext(domEnv, overrideInit = false) {
  const context = vm.createContext({
    ...domEnv.window,
    window: domEnv.window,
    document: domEnv.document,
    location: domEnv.window.location,
    localStorage: domEnv.window.localStorage,
    AudioContext: domEnv.window.AudioContext,
    webkitAudioContext: domEnv.window.webkitAudioContext,
    requestAnimationFrame: domEnv.window.requestAnimationFrame,
    cancelAnimationFrame: domEnv.window.cancelAnimationFrame,
    Node: domEnv.window.Node,
    Element: domEnv.window.Element,
    HTMLElement: domEnv.window.HTMLElement,
    HTMLVideoElement: domEnv.window.HTMLVideoElement,
    Event: class MockEvent {
      constructor(type) {
        this.type = type;
      }
    },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  });

  // Execute main.js script
  let code = mainJsCode;
  if (overrideInit) {
    // Prevent immediate auto-init so we can inspect internals before lifecycle runs
    code = code.replace("init();", "// init();");
  }
  code += `
; globalThis.state = state;
globalThis.activateMiniPlayer = activateMiniPlayer;
globalThis.deactivateMiniPlayer = deactivateMiniPlayer;
globalThis.applyQuality = applyQuality;
globalThis.setQualityViaMenu = setQualityViaMenu;
globalThis.isPremiumQualityOption = isPremiumQualityOption;
globalThis.findQualityOption = findQualityOption;
globalThis.dismissPremiumModal = dismissPremiumModal;
globalThis.ensureAudioPipeline = ensureAudioPipeline;
globalThis.toggleBoost = toggleBoost;
globalThis.showSkipToast = showSkipToast;
globalThis.dismissSkipToast = dismissSkipToast;
globalThis.renderSeekbarOverlay = renderSeekbarOverlay;
globalThis.showVolumeOverlay = showVolumeOverlay;
globalThis.showSpeedOverlay = showSpeedOverlay;
globalThis.injectSpeedButton = injectSpeedButton;
globalThis.injectBoostButton = injectBoostButton;
globalThis.setupVolumeGesture = setupVolumeGesture;
globalThis.setupPictureInPicture = setupPictureInPicture;
globalThis.bindPipVideo = bindPipVideo;
globalThis.checkPipReturn = checkPipReturn;
globalThis.exitAutoPip = exitAutoPip;
globalThis.isAdPlaying = isAdPlaying;
globalThis.startSegmentMonitor = startSegmentMonitor;
globalThis.stopSegmentMonitor = stopSegmentMonitor;
globalThis.handleSegmentsUpdate = handleSegmentsUpdate;
globalThis.handleSettingsUpdate = handleSettingsUpdate;
globalThis.bindSpeedVideo = bindSpeedVideo;
globalThis.onNavigate = onNavigate;
globalThis.isLiveStream = isLiveStream;
globalThis.syncMiniPlayerTheaterToggle = syncMiniPlayerTheaterToggle;
`;
  vm.runInContext(code, context);
  return context;
}

// =============================================================================
// SECTION 1: DOM reparenting and placeholder mechanics
// =============================================================================
console.log("--- SECTION 1: DOM Reparenting & Placeholder Mechanics ---");

runTest("MiniPlayer activation safely returns if ytdPlayer parentElement is missing", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  // Setup ytd-player without parent
  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  // ytdPlayer has no parentElement
  assert.strictEqual(ytdPlayer.parentElement, null);

  // Call activateMiniPlayer
  ctx.activateMiniPlayer();

  // State should remain inactive
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(env.document.body.children.includes(ytdPlayer), false);
});

runTest("MiniPlayer in-place activation and deactivation preserves parent and layout stability", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  env.document.body.appendChild(container);

  const prevSibling = env.document.createElement("div");
  container.appendChild(prevSibling);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  // Activate mini player in-place
  ctx.activateMiniPlayer();

  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(ytdPlayer.parentElement, container, "ytdPlayer must NEVER leave its container");
  assert.strictEqual(ytdPlayer.style.position, "fixed");
  assert.strictEqual(ytdPlayer.style.zIndex, "9999");
  assert.strictEqual(ytdPlayer.getAttribute("data-yt-adjust-mini"), "true");
  assert.strictEqual(moviePlayer.getAttribute("data-yt-adjust-mini"), "true");

  // Deactivate mini player in-place
  ctx.deactivateMiniPlayer();

  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(ytdPlayer.parentElement, container, "ytdPlayer remains in container");
  assert.strictEqual(ytdPlayer.style.position, "");
  assert.strictEqual(container.style.minHeight, "");
  assert.strictEqual(ytdPlayer.getAttribute("data-yt-adjust-mini"), null);
  assert.strictEqual(moviePlayer.getAttribute("data-yt-adjust-mini"), null);
});

runTest("MiniPlayer deactivation clears fixed styles and restores container minHeight", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  env.document.body.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);

  const sibling = env.document.createElement("div");
  sibling.id = "original-sibling";
  container.appendChild(sibling);
  env.elements.set("movie_player", moviePlayer);

  // Activate mini player
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(ytdPlayer.parentElement, container);

  // Deactivate mini player
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(ytdPlayer.parentElement, container);
  assert.strictEqual(ytdPlayer.style.position, "");
  assert.strictEqual(container.style.minHeight, "");
});

runTest("Repeated activateMiniPlayer and deactivateMiniPlayer calls are idempotent and safe", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  env.document.body.appendChild(container);
  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  // First activation
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(ytdPlayer.style.position, "fixed");

  // Second activation without deactivation (idempotency check)
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(ytdPlayer.style.position, "fixed");

  // Deactivation
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(ytdPlayer.style.position, "");

  // Second deactivation without activation (idempotency check)
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(ytdPlayer.style.position, "");
});

runTest("MiniPlayer activation sets minHeight on #player ancestor and inserts in-flow placeholder", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const player = env.document.createElement("div");
  player.id = "player";
  env.document.body.appendChild(player);

  const playerOuter = env.document.createElement("div");
  playerOuter.id = "player-container-outer";
  player.appendChild(playerOuter);

  const container = env.document.createElement("div");
  container.id = "player-container";
  playerOuter.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.activateMiniPlayer();

  assert.strictEqual(ctx.state.miniPlayerActive, true);
  // Verify minHeight is preserved on all container levels
  assert.strictEqual(container.style.minHeight.endsWith("px"), true);
  assert.strictEqual(player.style.minHeight.endsWith("px"), true);
  assert.strictEqual(playerOuter.style.minHeight.endsWith("px"), true);

  // Verify in-flow placeholder is inserted before ytdPlayer
  const placeholder = env.document.getElementById("yt-adjust-player-placeholder");
  assert.ok(placeholder, "Placeholder element exists in DOM");
  assert.strictEqual(placeholder.style.display, "block");
  assert.strictEqual(placeholder.style.height.endsWith("px"), true);
  assert.strictEqual(placeholder.parentElement, container);
  assert.strictEqual(container.children[0], placeholder);
  assert.strictEqual(container.children[1], ytdPlayer);

  // Verify transition does not animate layout dimensions
  assert.ok(!ytdPlayer.style.transition || !ytdPlayer.style.transition.includes("all"), "No transition: all on layout properties");

  // Deactivate
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(container.style.minHeight, "");
  assert.strictEqual(player.style.minHeight, "");
  assert.strictEqual(playerOuter.style.minHeight, "");
  assert.strictEqual(env.document.getElementById("yt-adjust-player-placeholder"), null, "Placeholder removed on deactivation");
});

runTest("ensureVideoContainerStyles scopes video container and element styles strictly to mini-player", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  ctx.ensureVideoContainerStyles();

  const styleEl = env.document.getElementById("yt-adjust-video-fix");
  assert.ok(styleEl, "yt-adjust-video-fix stylesheet exists");
  const css = styleEl.textContent || "";

  // Must NOT contain unscoped rules that break normal YouTube watch view
  assert.strictEqual(
    css.includes("#movie_player .html5-video-container {"),
    false,
    "Must NOT contain unscoped #movie_player .html5-video-container rule"
  );
  assert.strictEqual(
    css.includes("#movie_player .html5-video-container video.html5-main-video {"),
    false,
    "Must NOT contain unscoped video.html5-main-video rule"
  );

  // Must contain scoped rules
  assert.ok(
    css.includes('[data-yt-adjust-mini="true"] .html5-video-container'),
    "Must scope container rule to data-yt-adjust-mini"
  );
  assert.ok(
    css.includes('[data-yt-adjust-mini="true"] .html5-video-container video.html5-main-video'),
    "Must scope video element rule to data-yt-adjust-mini"
  );
});

runTest("deactivateMiniPlayer resets video and container inline styles completely without leaving overrides", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.className = "html5-video-container";
  env.document.body.appendChild(container);

  const video = env.document.createElement("video");
  video.className = "html5-main-video";
  container.appendChild(video);
  env.elements.set("video", video);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  env.document.body.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  // Activate mini player
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(video.style.width, "100%");
  assert.strictEqual(video.style.height, "100%");
  assert.strictEqual(video.style.objectFit, "contain");

  // Deactivate mini player
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(video.style.width, "", "video.style.width reset to empty string");
  assert.strictEqual(video.style.height, "", "video.style.height reset to empty string");
  assert.strictEqual(video.style.left, "", "video.style.left reset to empty string");
  assert.strictEqual(video.style.top, "", "video.style.top reset to empty string");
  assert.strictEqual(video.style.objectFit, "", "video.style.objectFit reset to empty string");
  assert.strictEqual(container.style.width, "", "container.style.width reset to empty string");
  assert.strictEqual(container.style.height, "", "container.style.height reset to empty string");
});

runTest("deactivateMiniPlayer faithfully restores pre-existing YouTube inline dimensions and layout minHeight without blowout", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const theaterContainer = env.document.createElement("div");
  theaterContainer.id = "player-theater-container";
  theaterContainer.style.minHeight = "640px";
  env.document.body.appendChild(theaterContainer);

  const container = env.document.createElement("div");
  container.className = "html5-video-container";
  theaterContainer.appendChild(container);

  const video = env.document.createElement("video");
  video.className = "html5-main-video";
  video.style.width = "1422px";
  video.style.height = "800px";
  video.style.left = "249px";
  video.style.top = "0px";
  container.appendChild(video);
  env.elements.set("video", video);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  moviePlayer.style.width = "1920px";
  moviePlayer.style.height = "800px";
  ytdPlayer.appendChild(moviePlayer);
  theaterContainer.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  // Activate mini player
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  assert.strictEqual(video.style.width, "100%");
  assert.strictEqual(video.style.height, "100%");
  assert.strictEqual(video.style.left, "0px");

  // Deactivate mini player
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  // Pre-existing YouTube inline dimensions MUST be restored exactly
  assert.strictEqual(video.style.width, "1422px", "Restores native YouTube video width");
  assert.strictEqual(video.style.height, "800px", "Restores native YouTube video height");
  assert.strictEqual(video.style.left, "249px", "Restores native YouTube video left coordinate");
  assert.strictEqual(video.style.top, "0px", "Restores native YouTube video top coordinate");
  assert.strictEqual(theaterContainer.style.minHeight, "640px", "Restores native theater container minHeight");
  assert.strictEqual(moviePlayer.style.width, "1920px", "Restores moviePlayer width");
  assert.strictEqual(moviePlayer.style.height, "800px", "Restores moviePlayer height");
});

runTest("onMiniPlayerScroll hysteresis prevents deactivation fluttering between 56px and 80px", () => {
  const env = createDomEnvironment({ playerBottom: 30 });
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  container.getBoundingClientRect = () => ({ top: -200, bottom: 30, left: 0, right: 1280, width: 1280, height: 720 });
  env.document.body.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.setupMiniPlayer();

  const scrollListeners = env.eventListeners.get("scroll") || [];
  const scrollHandler = scrollListeners[0].listener;

  // Activate past threshold (30 < 56)
  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini player activated at bottom 30");

  // User scrolls slightly up so bottom is 65px (between 56 and 80)
  // Without hysteresis, this would immediately deactivate and jump.
  // With hysteresis (threshold 80), it must remain active.
  container.getBoundingClientRect = () => ({ top: -150, bottom: 65, left: 0, right: 1280, width: 1280, height: 720 });
  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini player remains active in hysteresis zone (bottom = 65)");

  // User scrolls further up so bottom is 85px (>= 80)
  container.getBoundingClientRect = () => ({ top: -100, bottom: 85, left: 0, right: 1280, width: 1280, height: 720 });
  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini player deactivates cleanly when reaching deactivation threshold (bottom = 85)");
});

runTest("Theater mode: MiniPlayer activation sets minHeight on theater container and NOT on #player", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  // In theater mode:
  // #player exists in the DOM inside #primary (height: 0)
  const player = env.document.createElement("div");
  player.id = "player";
  player.getBoundingClientRect = () => ({ top: 600, bottom: 600, left: 0, right: 1280, width: 1280, height: 0 });
  env.document.body.appendChild(player);

  // ytd-player is inside #player-theater-container
  const theaterContainer = env.document.createElement("div");
  theaterContainer.id = "player-theater-container";
  theaterContainer.getBoundingClientRect = () => ({ top: -600, bottom: 40, left: 0, right: 1280, width: 1280, height: 640 });
  theaterContainer.offsetWidth = 1280;
  theaterContainer.offsetHeight = 640;
  env.document.body.appendChild(theaterContainer);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  theaterContainer.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.activateMiniPlayer();

  assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini player activated in theater mode");
  // The theater container must have its minHeight preserved to prevent layout collapse
  assert.strictEqual(theaterContainer.style.minHeight.endsWith("px"), true, "Theater container minHeight set");
  // The empty #player in #primary must NOT have minHeight set (which would create a phantom blank gap)
  assert.ok(!player.style.minHeight, "#player minHeight is untouched in theater mode");

  // Deactivate
  ctx.deactivateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini player deactivated");
  assert.strictEqual(theaterContainer.style.minHeight, "", "Theater container minHeight cleared");
  assert.ok(!player.style.minHeight, "#player minHeight remains empty");
});

runTest("Fullscreen: onMiniPlayerScroll does NOT activate mini player while document.fullscreenElement is active", () => {
  const env = createDomEnvironment({ playerBottom: 30, fullscreenElement: true });
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  container.getBoundingClientRect = () => ({ top: -200, bottom: 30, left: 0, right: 1280, width: 1280, height: 720 });
  env.document.body.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.setupMiniPlayer();

  const scrollListeners = env.eventListeners.get("scroll") || [];
  const scrollHandler = scrollListeners[0].listener;

  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini player must NOT activate during fullscreen");
});

runTest("Window resize: updates preserved container minHeight and placeholder height when miniPlayerActive", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const player = env.document.createElement("div");
  player.id = "player";
  player.clientWidth = 1200;
  env.document.body.appendChild(player);

  const container = env.document.createElement("div");
  container.id = "player-container";
  container.clientWidth = 1200;
  player.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  const video = env.document.createElement("video");
  video.className = "html5-main-video";
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  moviePlayer.appendChild(video);

  ctx.setupMiniPlayer();
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);

  // Simulate window resize: player container narrows to 800px
  player.clientWidth = 800;
  container.clientWidth = 800;
  const resizeListeners = env.eventListeners.get("resize") || [];
  const resizeHandler = resizeListeners[0] ? resizeListeners[0].listener : null;
  assert.ok(resizeHandler, "Resize listener registered");
  resizeHandler();

  const placeholder = env.document.getElementById("yt-adjust-player-placeholder");
  assert.ok(placeholder, "Placeholder exists");
  // 800 * 9/16 = 450px
  assert.strictEqual(placeholder.style.height, "450px", "Placeholder height updated on window resize");
  assert.strictEqual(player.style.minHeight, "450px", "Player minHeight updated on window resize");
});

// =============================================================================
// SECTION 2: Web Audio API Lifecycle & Caching
// =============================================================================
console.log("\n--- SECTION 2: Web Audio API Lifecycle & Caching ---");

runTest("ensureAudioPipeline creates MediaElementSource exactly ONCE and caches it", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const video = env.document.createElement("video");

  // Call ensureAudioPipeline multiple times
  ctx.ensureAudioPipeline(video);
  assert.strictEqual(env.getCreateSourceCallCount(), 1, "createMediaElementSource called once on first setup");
  assert.ok(ctx.state.audioContext, "AudioContext created");
  assert.ok(ctx.state.mediaSource, "MediaSource created");
  assert.ok(ctx.state.gainNode, "GainNode created");

  ctx.ensureAudioPipeline(video);
  assert.strictEqual(env.getCreateSourceCallCount(), 1, "createMediaElementSource not called again");

  ctx.ensureAudioPipeline(video);
  assert.strictEqual(env.getCreateSourceCallCount(), 1, "createMediaElementSource call count remains 1");
});

runTest("toggleBoost repeatedly modulates gain without re-creating audio pipeline", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  video.className = "html5-main-video";
  video.volume = 0.8;
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  // Turn boost ON
  ctx.toggleBoost();
  assert.strictEqual(ctx.state.boostActive, true);
  assert.strictEqual(ctx.state.gainNode.gain.value, 1.5, "Gain set to 150%");
  assert.strictEqual(env.getCreateSourceCallCount(), 1);

  // Turn boost OFF
  ctx.toggleBoost();
  assert.strictEqual(ctx.state.boostActive, false);
  assert.strictEqual(ctx.state.gainNode.gain.value, 1.0, "Gain reset to 100%");
  assert.strictEqual(env.getCreateSourceCallCount(), 1);

  // Turn boost ON again
  ctx.toggleBoost();
  assert.strictEqual(ctx.state.boostActive, true);
  assert.strictEqual(ctx.state.gainNode.gain.value, 1.5);
  assert.strictEqual(env.getCreateSourceCallCount(), 1, "Pipeline reused on reactivation");
});

runTest("toggleBoost resumes suspended AudioContext on user gesture", () => {
  const env = createDomEnvironment({ initialAudioState: "suspended" });
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  video.volume = 1;
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.toggleBoost();
  assert.strictEqual(ctx.state.audioContext.state, "running", "AudioContext resumed to running");
  assert.strictEqual(ctx.state.audioContext.resumeCallCount, 1, "resume was invoked");
});

runTest("toggleBoost handles AudioContext resume failure gracefully", () => {
  const env = createDomEnvironment({ initialAudioState: "suspended", audioResumeRejects: true });
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  video.volume = 1;
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  let threw = false;
  try {
    ctx.toggleBoost();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "toggleBoost must not crash if resume rejects");
});

runTest("ensureAudioPipeline and toggleBoost handle missing AudioContext gracefully", () => {
  const env = createDomEnvironment();
  env.window.AudioContext = undefined;
  env.window.webkitAudioContext = undefined;

  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  let threw = false;
  try {
    ctx.toggleBoost();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "toggleBoost must not crash when AudioContext is unsupported");
  assert.strictEqual(ctx.state.audioContext, null);
  assert.strictEqual(ctx.state.mediaSource, null);
});

// =============================================================================
// SECTION 3: TrustedHTML CSP Compliance
// =============================================================================
console.log("\n--- SECTION 3: TrustedHTML CSP Compliance ---");

runTest("Static verification: zero innerHTML / outerHTML / insertAdjacentHTML occurrences in code", () => {
  const files = [
    { name: "content/main.js", code: mainJsCode },
    { name: "content/isolated.js", code: isolatedJsCode },
    { name: "popup/popup.js", code: popupJsCode },
  ];

  // Match active code occurrences after stripping comments
  const innerHtmlRegex = /(innerHTML|outerHTML|insertAdjacentHTML)\s*(=|\()/;

  for (const f of files) {
    // Strip block comments and line comments (preserving URLs like https://) for clean check
    const cleanCode = f.code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    const match = cleanCode.match(innerHtmlRegex);
    assert.strictEqual(match, null, `Found forbidden HTML string sink in ${f.name}: ${match ? match[0] : ""}`);
  }
});

runTest("Runtime execution under strict TrustedHTML CSP policy", () => {
  const env = createDomEnvironment({ strictCsp: true });
  const ctx = loadMainJsInContext(env, true);

  // Setup full player DOM
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  moviePlayer.className = "html5-video-player";

  const video = env.document.createElement("video");
  video.className = "html5-main-video";
  video.duration = 600;
  video.currentTime = 50;
  moviePlayer.appendChild(video);

  const ytdPlayer = env.document.createElement("ytd-player");
  ytdPlayer.appendChild(moviePlayer);

  const rightControlsLeft = env.document.createElement("div");
  rightControlsLeft.className = "ytp-right-controls-left";
  const settingsBtn = env.document.createElement("button");
  settingsBtn.className = "ytp-settings-button";
  rightControlsLeft.appendChild(settingsBtn);
  moviePlayer.appendChild(rightControlsLeft);

  const volumeArea = env.document.createElement("div");
  volumeArea.className = "ytp-volume-area";
  moviePlayer.appendChild(volumeArea);

  const chaptersContainer = env.document.createElement("div");
  chaptersContainer.className = "ytp-chapters-container";
  moviePlayer.appendChild(chaptersContainer);

  env.document.body.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  // 1. Skip Toast (show and dismiss)
  ctx.showSkipToast("Sponsor skipped (30s)", 10);
  const toast = env.document.getElementById("yt-adjust-toast");
  assert.ok(toast, "Toast element created without CSP violation");
  ctx.dismissSkipToast();

  // 2. Seekbar overlay
  ctx.state.settings.sponsorblockEnabled = true;
  ctx.state.segments = [
    { category: "sponsor", actionType: "skip", segment: [100, 150], UUID: "u1" }
  ];
  ctx.renderSeekbarOverlay();
  const overlay = env.document.getElementById("yt-adjust-seekbar-overlay");
  assert.ok(overlay, "Seekbar overlay created without CSP violation");

  // 3. Volume HUD overlay
  ctx.showVolumeOverlay(75);
  const volOverlay = env.document.getElementById("yt-adjust-volume-overlay");
  assert.ok(volOverlay, "Volume HUD created without CSP violation");

  // 4. Speed HUD overlay
  ctx.showSpeedOverlay(1.5);
  const speedOverlay = env.document.getElementById("yt-adjust-speed-overlay");
  assert.ok(speedOverlay, "Speed HUD created without CSP violation");

  // 5. Speed button injection
  ctx.injectSpeedButton();
  const speedBtn = env.document.getElementById("yt-adjust-speed-btn");
  assert.ok(speedBtn, "Speed button injected without CSP violation");

  // 6. Boost button injection
  ctx.injectBoostButton();
  const boostBtn = env.document.getElementById("yt-adjust-boost-btn");
  assert.ok(boostBtn, "Boost button injected without CSP violation");

  // 7. MiniPlayer activation
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);
  const closeBtn = env.document.getElementById("yt-adjust-mp-close");
  assert.ok(closeBtn, "MiniPlayer close button injected without CSP violation");
  ctx.deactivateMiniPlayer();
});

// =============================================================================
// SECTION 4: YouTube Player Method Null Guards
// =============================================================================
console.log("\n--- SECTION 4: YouTube Player Method Null Guards ---");

runTest("applyQuality handles missing movie_player element", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  // No movie_player in DOM
  assert.strictEqual(env.document.getElementById("movie_player"), null);

  let threw = false;
  try {
    ctx.applyQuality();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "applyQuality must not throw when movie_player is missing");
  assert.strictEqual(ctx.state.qualityRetryCount, 1, "retryQuality was scheduled");
});

runTest("applyQuality handles player without getPlaybackQualityLabel method", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  // getPlaybackQualityLabel is undefined
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  let threw = false;
  try {
    ctx.applyQuality();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "applyQuality must not throw when getPlaybackQualityLabel is undefined");
});

runTest("isPremiumQualityOption correctly identifies premium / enhanced bitrate options", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const premiumOpt = env.document.createElement("div");
  premiumOpt.className = "ytp-menuitem";
  const premiumLabel = env.document.createElement("div");
  premiumLabel.className = "ytp-menuitem-label";
  premiumLabel.textContent = "1080p Premium HD";
  const premiumSublabel = env.document.createElement("div");
  premiumSublabel.className = "ytp-menuitem-sublabel";
  premiumSublabel.textContent = "Enhanced bitrate";
  premiumOpt.appendChild(premiumLabel);
  premiumOpt.appendChild(premiumSublabel);

  const standardOpt = env.document.createElement("div");
  standardOpt.className = "ytp-menuitem";
  const standardLabel = env.document.createElement("div");
  standardLabel.className = "ytp-menuitem-label";
  standardLabel.textContent = "1080p HD";
  standardOpt.appendChild(standardLabel);

  const ariaPremiumOpt = env.document.createElement("div");
  ariaPremiumOpt.className = "ytp-menuitem";
  ariaPremiumOpt.setAttribute("aria-label", "1080p Premium with enhanced bitrate");
  const ariaLabel = env.document.createElement("div");
  ariaLabel.className = "ytp-menuitem-label";
  ariaLabel.textContent = "1080p";
  ariaPremiumOpt.appendChild(ariaLabel);

  const regular720 = env.document.createElement("div");
  regular720.className = "ytp-menuitem";
  const label720 = env.document.createElement("div");
  label720.className = "ytp-menuitem-label";
  label720.textContent = "720p";
  regular720.appendChild(label720);

  assert.strictEqual(ctx.isPremiumQualityOption(premiumOpt), true, "Identifies 1080p Premium HD as premium");
  assert.strictEqual(ctx.isPremiumQualityOption(standardOpt), false, "Standard 1080p HD is NOT marked premium");
  assert.strictEqual(ctx.isPremiumQualityOption(ariaPremiumOpt), true, "Identifies aria-label premium as premium");
  assert.strictEqual(ctx.isPremiumQualityOption(regular720), false, "720p is NOT marked premium");

  // Test detection via .ytp-premium-label element
  const iconPremiumOpt = env.document.createElement("div");
  iconPremiumOpt.className = "ytp-menuitem";
  const iconLabel = env.document.createElement("div");
  iconLabel.className = "ytp-menuitem-label";
  iconLabel.textContent = "1080p";
  const badgeEl = env.document.createElement("span");
  badgeEl.className = "ytp-premium-label";
  iconPremiumOpt.appendChild(iconLabel);
  iconPremiumOpt.appendChild(badgeEl);
  assert.strictEqual(ctx.isPremiumQualityOption(iconPremiumOpt), true, "Identifies .ytp-premium-label as premium");

  // Test detection via sublabel containing bitrate
  const sublabelOpt = env.document.createElement("div");
  sublabelOpt.className = "ytp-menuitem";
  const sublabel = env.document.createElement("div");
  sublabel.className = "ytp-menuitem-sublabel";
  sublabel.textContent = "Enhanced bitrate";
  sublabelOpt.appendChild(sublabel);
  assert.strictEqual(ctx.isPremiumQualityOption(sublabelOpt), true, "Identifies sublabel with enhanced bitrate as premium");
});

runTest("findQualityOption selects standard 1080p and rejects duplicate premium option", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const premiumOpt = env.document.createElement("div");
  premiumOpt.className = "ytp-menuitem";
  const pLabel = env.document.createElement("div");
  pLabel.className = "ytp-menuitem-label";
  pLabel.textContent = "1080p Premium HD";
  const pSub = env.document.createElement("div");
  pSub.className = "ytp-menuitem-sublabel";
  pSub.textContent = "Enhanced bitrate";
  premiumOpt.appendChild(pLabel);
  premiumOpt.appendChild(pSub);

  const standardOpt = env.document.createElement("div");
  standardOpt.className = "ytp-menuitem";
  const sLabel = env.document.createElement("div");
  sLabel.className = "ytp-menuitem-label";
  sLabel.textContent = "1080p HD";
  standardOpt.appendChild(sLabel);

  const opt720 = env.document.createElement("div");
  opt720.className = "ytp-menuitem";
  const l720 = env.document.createElement("div");
  l720.className = "ytp-menuitem-label";
  l720.textContent = "720p";
  opt720.appendChild(l720);

  const options = [premiumOpt, standardOpt, opt720];

  // Primary selection for 1080p
  const chosen = ctx.findQualityOption(options, "1080p");
  assert.strictEqual(chosen, standardOpt, "Specifically picks standard 1080p HD over duplicate 1080p Premium HD");

  // When only premium tier exists for 1080p, findQualityOption returns null to avoid purchase modal
  const premiumOnlyOptions = [premiumOpt, opt720];
  const nullChosen = ctx.findQualityOption(premiumOnlyOptions, "1080p");
  assert.strictEqual(nullChosen, null, "Refuses to pick premium option when no free tier exists");

  // Fallback to 720p succeeds
  const fallbackChosen = ctx.findQualityOption(premiumOnlyOptions, "720p");
  assert.strictEqual(fallbackChosen, opt720, "Fallback selects 720p cleanly");
});

runTest("dismissPremiumModal dismisses YouTube Premium purchase modal by clicking Not now", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const dialog = env.document.createElement("tp-yt-paper-dialog");
  let clicked = false;
  const notNowBtn = env.document.createElement("button");
  notNowBtn.textContent = "Not now";
  notNowBtn.addEventListener("click", () => {
    clicked = true;
    dialog.remove();
  });
  dialog.appendChild(notNowBtn);
  env.document.body.appendChild(dialog);

  const dismissed = ctx.dismissPremiumModal();
  assert.strictEqual(dismissed, true, "dismissPremiumModal returns true when dialog dismissed");
  assert.strictEqual(clicked, true, "Not now button was clicked");
  assert.strictEqual(dialog.parentElement, null, "Dialog was removed");
});

runTest("Volume gestures handle null and non-function player methods with video fallbacks", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  video.volume = 0.5;
  video.muted = true;
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  // Player has NO custom methods (getVolume, setVolume, isMuted, unMute are undefined)
  assert.strictEqual(moviePlayer.getVolume, undefined);
  assert.strictEqual(moviePlayer.setVolume, undefined);
  assert.strictEqual(moviePlayer.isMuted, undefined);
  assert.strictEqual(moviePlayer.unMute, undefined);

  ctx.setupVolumeGesture();

  // Find the wheel listener registered on document
  const wheelListeners = env.eventListeners.get("wheel") || [];
  assert.ok(wheelListeners.length > 0, "Wheel listener registered");
  const wheelHandler = wheelListeners[0].listener;

  // Simulate right-click depression
  ctx.state.rightMouseDown = true;
  ctx.state.settings.volumeGestureEnabled = true;

  // Simulate wheel scroll up (direction > 0)
  const wheelEvent = {
    target: video,
    deltaY: -100, // scroll up
    deltaX: 0,
    shiftKey: false,
    preventDefault() {},
    stopImmediatePropagation() {},
  };

  let threw = false;
  try {
    wheelHandler(wheelEvent);
  } catch (err) {
    threw = true;
    console.error("Caught error during volume wheel handler:", err);
  }

  assert.strictEqual(threw, false, "Wheel handler must not throw when player methods are missing");
  assert.strictEqual(video.volume, 0.55, "Fell back to video.volume (50% + 5% = 55%)");
  assert.strictEqual(video.muted, false, "Fell back to video.muted = false on auto-unmute");
});

runTest("toggleBoost handles missing getVolume method on player", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  const video = env.document.createElement("video");
  video.volume = 0.6;
  moviePlayer.appendChild(video);
  env.document.body.appendChild(moviePlayer);
  env.elements.set("movie_player", moviePlayer);

  // moviePlayer.getVolume is undefined
  assert.strictEqual(moviePlayer.getVolume, undefined);

  let threw = false;
  try {
    ctx.toggleBoost();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "toggleBoost must not throw when getVolume is undefined");
  assert.strictEqual(ctx.state.boostActive, true);
});

runTest("onMiniPlayerScroll respects dismissal and viewport boundaries", () => {
  const env = createDomEnvironment({ playerBottom: 30 }); // scrolled past threshold (< 56)
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  container.getBoundingClientRect = () => ({ top: -200, bottom: 30, left: 0, right: 1280, width: 1280, height: 720 });
  env.document.body.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.setupMiniPlayer();

  // Trigger scroll when below threshold
  const scrollListeners = env.eventListeners.get("scroll") || [];
  assert.ok(scrollListeners.length > 0, "Scroll listener registered");
  const scrollHandler = scrollListeners[0].listener;

  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini player activated when scrolled past threshold");

  // User clicks close button
  const closeBtn = env.document.getElementById("yt-adjust-mp-close");
  assert.ok(closeBtn, "Close button exists");
  closeBtn.dispatchEvent({ type: "click" });

  assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini player deactivated on close click");
  assert.strictEqual(ctx.state.miniPlayerDismissed, true, "miniPlayerDismissed set to true");

  // Subsequent scroll while still past threshold should NOT re-activate mini player
  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini player remains inactive while dismissed");

  // Scroll back to top (bottom >= 56)
  container.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 1280, width: 1280, height: 720 });
  scrollHandler();
  assert.strictEqual(ctx.state.miniPlayerDismissed, false, "miniPlayerDismissed reset when scrolling back to top");
});

runTest("teardownMiniPlayer unbinds scroll listener and deactivates floating player", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const container = env.document.createElement("div");
  container.id = "player-container";
  env.document.body.appendChild(container);

  const ytdPlayer = env.document.createElement("ytd-player");
  const moviePlayer = env.document.createElement("div");
  moviePlayer.id = "movie_player";
  ytdPlayer.appendChild(moviePlayer);
  container.appendChild(ytdPlayer);
  env.elements.set("movie_player", moviePlayer);

  ctx.setupMiniPlayer();
  ctx.activateMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, true);

  // Teardown
  ctx.teardownMiniPlayer();
  assert.strictEqual(ctx.state.miniPlayerActive, false);
  assert.strictEqual(ctx.state.miniPlayerDismissed, false);
});

runTest("ensureAudioPipeline catches and logs createMediaElementSource exceptions (e.g. CORS/Security)", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  const video = env.document.createElement("video");

  // Simulate AudioContext where createMediaElementSource throws a SecurityError
  env.window.AudioContext = class ThrowingAudioContext {
    createGain() { return { gain: { value: 1.0 }, connect() {} }; }
    createMediaElementSource() {
      throw new Error("SecurityError: Media element has cross-origin content without CORS headers");
    }
  };

  let threw = false;
  try {
    ctx.ensureAudioPipeline(video);
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "ensureAudioPipeline must not throw when createMediaElementSource fails");
  assert.strictEqual(ctx.state.mediaSource, null, "mediaSource remains null on failure");
});

runTest("toggleBoost safely returns if getVideo returns null", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  // No video element in DOM
  let threw = false;
  try {
    ctx.toggleBoost();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "toggleBoost must not throw when video is missing");
  assert.strictEqual(ctx.state.boostActive, false);
});

runTest("onNavigate tears down state when leaving /watch page", () => {
  const env = createDomEnvironment();
  const ctx = loadMainJsInContext(env, true);

  // Navigate away from watch page
  env.window.location.pathname = "/feed/subscriptions";

  let threw = false;
  try {
    ctx.onNavigate();
  } catch (err) {
    threw = true;
  }
  assert.strictEqual(threw, false, "onNavigate must not throw when on non-watch page");
  assert.strictEqual(ctx.state.miniPlayerActive, false);
});

async function runTestAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`PASS: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
  }
}

(async () => {
  // =============================================================================
  // SECTION 5: Picture-in-Picture Mechanics
  // =============================================================================
  console.log("\n--- SECTION 5: Picture-in-Picture Mechanics ---");

  function setupPipDom(env) {
    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    moviePlayer.className = "html5-video-player";

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.paused = false;
    video.ended = false;
    video.readyState = 4;
    video.autoPictureInPicture = false;

    let pipRequested = 0;
    video.requestPictureInPicture = async () => {
      pipRequested++;
      env.document.pictureInPictureElement = video;
      return {};
    };

    moviePlayer.appendChild(video);
    const ytdPlayer = env.document.createElement("ytd-player");
    ytdPlayer.appendChild(moviePlayer);
    env.document.body.appendChild(ytdPlayer);
    env.elements.set("movie_player", moviePlayer);

    let pipExited = 0;
    env.document.pictureInPictureEnabled = true;
    env.document.pictureInPictureElement = null;
    env.document.visibilityState = "visible";
    env.document.exitPictureInPicture = async () => {
      pipExited++;
      env.document.pictureInPictureElement = null;
    };

    return {
      player: moviePlayer,
      video,
      getPipRequested: () => pipRequested,
      getPipExited: () => pipExited,
    };
  }

  await runTestAsync("Alt + P keyboard shortcut toggles Picture-in-Picture on active video", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();

    let prevented = false;
    const keyDownEvent1 = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      key: "p",
      preventDefault: () => { prevented = true; },
    };

    // First Alt+P: request PiP
    env.document.dispatchEvent(keyDownEvent1);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(prevented, true, "preventDefault called on Alt+P");
    assert.strictEqual(dom.getPipRequested(), 1, "requestPictureInPicture called once");
    assert.strictEqual(env.document.pictureInPictureElement, dom.video);

    // Second Alt+P: exit PiP
    prevented = false;
    const keyDownEvent2 = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      key: "p",
      preventDefault: () => { prevented = true; },
    };
    env.document.dispatchEvent(keyDownEvent2);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(prevented, true, "preventDefault called on second Alt+P");
    assert.strictEqual(dom.getPipExited(), 1, "exitPictureInPicture called once");
    assert.strictEqual(env.document.pictureInPictureElement, null);
  });

  await runTestAsync("Alt + P keyboard shortcut works case-insensitively with uppercase 'P'", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();

    let prevented = false;
    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      key: "P",
      preventDefault: () => { prevented = true; },
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(prevented, true);
    assert.strictEqual(dom.getPipRequested(), 1);
  });

  await runTestAsync("Alt + P shortcut ignored when Ctrl or Meta key is pressed", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();

    // Ctrl + Alt + P
    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: true,
      metaKey: false,
      isComposing: false,
      key: "p",
      preventDefault: () => {},
    });
    // Meta + Alt + P
    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      isComposing: false,
      key: "p",
      preventDefault: () => {},
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dom.getPipRequested(), 0, "No PiP requested when modifier keys present");
  });

  await runTestAsync("Alt + P shortcut does nothing when pipEnabled is false", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();
    ctx.state.settings.pipEnabled = false;

    let prevented = false;
    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      key: "p",
      preventDefault: () => { prevented = true; },
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(prevented, false);
    assert.strictEqual(dom.getPipRequested(), 0);
  });

  await runTestAsync("Auto-PiP activates on tab switch (visibilityState = hidden) and exits on visible", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();

    // Switch away from tab while actively playing
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 1, "Auto-PiP requested on hidden");
    assert.strictEqual(ctx.state.pipAutoTriggered, true, "pipAutoTriggered flag set");

    // Return to tab
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipExited(), 1, "Auto-PiP exited on visible");
    assert.strictEqual(ctx.state.pipAutoTriggered, false, "pipAutoTriggered flag reset");
  });

  await runTestAsync("Auto-PiP does NOT activate on tab switch if video is paused", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();

    dom.video.paused = true;
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 0);
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
  });

  await runTestAsync("Auto-PiP does NOT activate on tab switch if video readyState < 2", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();

    dom.video.readyState = 1;
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 0);
  });

  await runTestAsync("Auto-PiP does NOT activate on tab switch if pipAutoOnTabSwitch is false", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();
    ctx.state.settings.pipAutoOnTabSwitch = false;

    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 0);
  });

  await runTestAsync("Manual PiP via Alt+P is NOT exited when returning to tab", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();

    // User manually presses Alt+P
    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      key: "p",
      preventDefault: () => {},
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ctx.state.pipAutoTriggered, false, "Manual PiP leaves pipAutoTriggered = false");

    // Switch away and back
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipExited(), 0, "Manual PiP must NOT exit on returning to tab");
    assert.strictEqual(env.document.pictureInPictureElement, dom.video);
  });

  await runTestAsync("leavepictureinpicture event resets pipAutoTriggered", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    ctx.state.pipAutoTriggered = true;
    dom.video.dispatchEvent({ type: "leavepictureinpicture" });
    assert.strictEqual(ctx.state.pipAutoTriggered, false, "resets on video leavepictureinpicture event");

    ctx.state.pipAutoTriggered = true;
    env.document.dispatchEvent({ type: "leavepictureinpicture" });
    assert.strictEqual(ctx.state.pipAutoTriggered, false, "resets on document capturing leavepictureinpicture event");
  });

  await runTestAsync("Alt + P shortcut ignores keydown when e.repeat is true", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();

    env.document.dispatchEvent({
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      isComposing: false,
      repeat: true,
      key: "p",
      preventDefault: () => {},
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dom.getPipRequested(), 0, "No PiP requested when keydown repeat is true");
  });

  await runTestAsync("enterpictureinpicture deactivates miniPlayerActive and cleans up floating frame", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    ctx.state.miniPlayerActive = true;
    dom.video.dispatchEvent({ type: "enterpictureinpicture" });
    assert.strictEqual(ctx.state.miniPlayerActive, false, "miniPlayerActive deactivated on PiP entry");
  });

  await runTestAsync("bindPipVideo synchronizes autoPictureInPicture on HTMLVideoElement", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);

    ctx.state.settings.pipEnabled = true;
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.bindPipVideo(dom.video);
    assert.strictEqual(dom.video.autoPictureInPicture, true);

    ctx.state.settings.pipAutoOnTabSwitch = false;
    ctx.bindPipVideo(dom.video);
    assert.strictEqual(dom.video.autoPictureInPicture, false);
  });

  await runTestAsync("handleSettingsUpdate exits auto-PiP and disables autoPictureInPicture when pipEnabled toggled off", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);

    ctx.state.pipAutoTriggered = true;
    env.document.pictureInPictureElement = dom.video;
    dom.video.autoPictureInPicture = true;

    ctx.handleSettingsUpdate({ pipEnabled: false });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.video.autoPictureInPicture, false);
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
  });

  await runTestAsync("handleSettingsUpdate exits auto-PiP when pipAutoOnTabSwitch toggled off", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);

    ctx.state.pipAutoTriggered = true;
    env.document.pictureInPictureElement = dom.video;
    dom.video.autoPictureInPicture = true;

    ctx.handleSettingsUpdate({ pipAutoOnTabSwitch: false });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.video.autoPictureInPicture, false);
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
  });

  await runTestAsync("Auto-PiP cleanly exits on tab return even after intermediate tab switches", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // 1. User switches from YouTube to Tab 2 (Messenger)
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 1, "Auto-PiP requested on first tab switch");

    // 2. Real browser dispatches enterpictureinpicture event
    dom.video.dispatchEvent({ type: "enterpictureinpicture" });
    await new Promise((r) => setImmediate(r));

    // Flag must remain true so tab-return exit is not skipped!
    assert.strictEqual(ctx.state.pipAutoTriggered, true, "pipAutoTriggered preserved after enterpictureinpicture");
    assert.strictEqual(ctx.state.pipManualTriggered, false, "pipManualTriggered remains false for auto-PiP");

    // 3. User switches to Tab 3 (New Tab / Other Tab) - YouTube stays hidden
    // Simulate window blur or additional intermediate background ticks
    env.document.dispatchEvent({ type: "blur" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(ctx.state.pipAutoTriggered, true, "pipAutoTriggered preserved across intermediate tabs");

    // 4. User finally returns to YouTube tab
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipExited(), 1, "Auto-PiP successfully exited on returning to tab");
    assert.strictEqual(ctx.state.pipAutoTriggered, false, "pipAutoTriggered flag reset after exit");
    assert.strictEqual(env.document.pictureInPictureElement, null, "pictureInPictureElement cleared");
  });

  await runTestAsync("Simultaneous visibilitychange and focus events are serialized by mutex without double exitPictureInPicture calls", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // Enter PiP on tab switch
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));
    dom.video.dispatchEvent({ type: "enterpictureinpicture" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 1);
    assert.strictEqual(dom.getPipExited(), 0);

    // Fire both visibilitychange (visible) and window focus simultaneously
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    env.window.dispatchEvent({ type: "focus" });
    await new Promise((r) => setImmediate(r));

    // Must execute exit exactly once, without concurrent duplicate exit calls
    assert.strictEqual(dom.getPipExited(), 1, "exitPictureInPicture called exactly ONCE despite dual concurrent events");
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
    assert.strictEqual(env.document.pictureInPictureElement, null);
  });

  await runTestAsync("In-flight exit request while triggerAutoPip is pending is queued and executed on resolution", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // Make requestPictureInPicture take some time
    let resolvePip;
    dom.video.requestPictureInPicture = () => new Promise((resolve) => {
      resolvePip = () => {
        env.document.pictureInPictureElement = dom.video;
        resolve({});
      };
    });

    // 1. Tab switches to hidden -> triggerAutoPip starts (mutex locked)
    env.document.visibilityState = "hidden";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    // 2. User quickly switches back to tab while request is still pending
    env.document.visibilityState = "visible";
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));

    // Exit could not run immediately because mutex was locked, but should be marked pending
    assert.strictEqual(dom.getPipExited(), 0);

    // 3. Now the browser finally completes requestPictureInPicture
    resolvePip();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));

    // The queued pending exit must have executed automatically in finally block
    assert.strictEqual(dom.getPipExited(), 1, "Pending exit executed immediately after requestPictureInPicture resolved");
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
  });

  await runTestAsync("onEnterPictureInPicture preserves auto-PiP even if document visibilityState is visible (Helium tab support)", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // Video enters PiP while document is visible (Helium keeps background tabs in visible state)
    env.document.visibilityState = "visible";
    env.document.pictureInPictureElement = dom.video;
    dom.video.dispatchEvent({ type: "enterpictureinpicture" });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipExited(), 0, "Does NOT immediately exit PiP on enter in visible tabs");
    assert.strictEqual(ctx.state.pipAutoTriggered, true, "pipAutoTriggered is preserved");
  });

  await runTestAsync("checkPipReturn exits auto-PiP after debounce window when user returns to tab", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // Video is in PiP
    env.document.pictureInPictureElement = dom.video;
    ctx.state.pipAutoTriggered = true;
    ctx.state.pipEnteredTime = Date.now() - 600; // Entered 600ms ago (> 500ms debounce)

    // User returns and interacts (pointerdown / focus / mousemove)
    ctx.checkPipReturn();
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(dom.getPipExited(), 1, "checkPipReturn cleanly exited auto-PiP on tab return");
    assert.strictEqual(ctx.state.pipAutoTriggered, false);
  });

  // =========================================================================
  // SECTION 6: Skip Notification Toast Lifecycle & Anti-Zombie Guards
  // =========================================================================
  console.log("\n--- SECTION 6: Skip Notification Toast Lifecycle & Anti-Zombie Guards ---");

  await runTestAsync("Skip notification toast: rapid sequential skips immediately wipe earlier toasts leaving exactly 1 element", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    env.document.body.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    // Simulate 3 rapid consecutive skips (like overlapping segments)
    ctx.showSkipToast("Intro skipped (4s)", 142.5);
    ctx.showSkipToast("Self-promo skipped (21s)", 145.9);
    ctx.showSkipToast("Intro skipped (5s)", 167.1);

    const toasts = env.document.querySelectorAll("#yt-adjust-toast, .yt-adjust-toast");
    assert.strictEqual(toasts.length, 1, "Exactly one toast exists in DOM despite rapid successive calls");
    assert.strictEqual(toasts[0].querySelector("span").textContent, "Intro skipped (5s)", "Active toast reflects latest skip");

    ctx.dismissSkipToast(true);
    const afterDismiss = env.document.querySelectorAll("#yt-adjust-toast, .yt-adjust-toast");
    assert.strictEqual(afterDismiss.length, 0, "All toasts completely purged on immediate dismiss");
  });

  await runTestAsync("Skip notification toast: dismissSkipToast(false) immediately strips identity and removes node after transition", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    env.document.body.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    ctx.showSkipToast("Sponsor skipped (30s)", 100);
    const toast = env.document.getElementById("yt-adjust-toast");
    assert.ok(toast, "Toast was mounted");

    ctx.dismissSkipToast(false);
    assert.strictEqual(toast.id, "", "ID removed immediately so queries never match dying element");
    assert.strictEqual(toast.className.includes("yt-adjust-toast"), false, "Class removed immediately");
    assert.strictEqual(toast.style.opacity, "0", "Opacity set to 0 for transition");

    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(toast.parentElement, null, "Toast node unmounted from parent after transition timeout");
  });

  await runTestAsync("Skip notification toast: mouseenter pauses dismiss timer and mouseleave schedules dismissal", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    env.document.body.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    ctx.showSkipToast("Intro skipped (5s)", 10);
    const toast = env.document.getElementById("yt-adjust-toast");
    assert.ok(toast, "Toast created");

    // Hover pauses timer
    toast.dispatchEvent({ type: "mouseenter" });
    await new Promise((r) => setTimeout(r, 100));

    // Mouse leaves
    toast.dispatchEvent({ type: "mouseleave" });
    await new Promise((r) => setTimeout(r, 1550));

    assert.strictEqual(toast.style.opacity, "0", "Toast opacity set to 0 after mouseleave delay");
  });

  await runTestAsync("setQualityViaMenu selects standard 1080p HD and bypasses 1080p Premium", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";

    // Settings button
    const settingsBtn = env.document.createElement("button");
    settingsBtn.className = "ytp-settings-button";
    player.appendChild(settingsBtn);

    // Initial menu item: "Quality"
    const qualityMenuItem = env.document.createElement("div");
    qualityMenuItem.className = "ytp-menuitem";
    const qLabel = env.document.createElement("div");
    qLabel.className = "ytp-menuitem-label";
    qLabel.textContent = "Quality";
    qualityMenuItem.appendChild(qLabel);
    player.appendChild(qualityMenuItem);

    let premiumClicked = false;
    let standard1080Clicked = false;

    const premiumOpt = env.document.createElement("div");
    premiumOpt.className = "ytp-menuitem";
    const pLabel = env.document.createElement("div");
    pLabel.className = "ytp-menuitem-label";
    pLabel.textContent = "1080p Premium HD";
    const pSub = env.document.createElement("div");
    pSub.textContent = "Enhanced bitrate";
    premiumOpt.appendChild(pLabel);
    premiumOpt.appendChild(pSub);
    premiumOpt.addEventListener("click", () => { premiumClicked = true; });

    const standardOpt = env.document.createElement("div");
    standardOpt.className = "ytp-menuitem";
    const sLabel = env.document.createElement("div");
    sLabel.className = "ytp-menuitem-label";
    sLabel.textContent = "1080p HD";
    standardOpt.appendChild(sLabel);
    standardOpt.addEventListener("click", () => { standard1080Clicked = true; });

    const opt720 = env.document.createElement("div");
    opt720.className = "ytp-menuitem";
    const l720 = env.document.createElement("div");
    l720.className = "ytp-menuitem-label";
    l720.textContent = "720p";
    opt720.appendChild(l720);

    // When qualityItem is clicked, simulate opening quality submenu
    qualityMenuItem.addEventListener("click", () => {
      qualityMenuItem.remove();
      player.appendChild(premiumOpt);
      player.appendChild(standardOpt);
      player.appendChild(opt720);
    });

    await ctx.setQualityViaMenu(player, "1080p");

    assert.strictEqual(premiumClicked, false, "1080p Premium must NEVER be clicked");
    assert.strictEqual(standard1080Clicked, true, "Standard 1080p HD must be clicked");
  });

  await runTestAsync("setQualityViaMenu fallback ignores 1080p Premium and selects standard 1080p HD", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";

    const settingsBtn = env.document.createElement("button");
    settingsBtn.className = "ytp-settings-button";
    player.appendChild(settingsBtn);

    const qualityMenuItem = env.document.createElement("div");
    qualityMenuItem.className = "ytp-menuitem";
    const qLabel = env.document.createElement("div");
    qLabel.className = "ytp-menuitem-label";
    qLabel.textContent = "Quality";
    qualityMenuItem.appendChild(qLabel);
    player.appendChild(qualityMenuItem);

    let premiumClicked = false;
    let standard1080Clicked = false;

    const premiumOpt = env.document.createElement("div");
    premiumOpt.className = "ytp-menuitem";
    const pLabel = env.document.createElement("div");
    pLabel.className = "ytp-menuitem-label";
    pLabel.textContent = "1080p Premium HD";
    const pSub = env.document.createElement("div");
    pSub.textContent = "Enhanced bitrate";
    premiumOpt.appendChild(pLabel);
    premiumOpt.appendChild(pSub);
    premiumOpt.addEventListener("click", () => { premiumClicked = true; });

    const standardOpt = env.document.createElement("div");
    standardOpt.className = "ytp-menuitem";
    const sLabel = env.document.createElement("div");
    sLabel.className = "ytp-menuitem-label";
    sLabel.textContent = "1080p HD";
    standardOpt.appendChild(sLabel);
    standardOpt.addEventListener("click", () => { standard1080Clicked = true; });

    qualityMenuItem.addEventListener("click", () => {
      qualityMenuItem.remove();
      player.appendChild(premiumOpt);
      player.appendChild(standardOpt);
    });

    // Request 1440p (target quality not in list, falls back to 1080p)
    await ctx.setQualityViaMenu(player, "1440p");

    assert.strictEqual(premiumClicked, false, "Fallback must NOT select 1080p Premium");
    assert.strictEqual(standard1080Clicked, true, "Fallback must select standard 1080p HD");
  });

  await runTestAsync("setQualityViaMenu Auto fallback does NOT select 2160p when Auto is absent", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";

    const settingsBtn = env.document.createElement("button");
    settingsBtn.className = "ytp-settings-button";
    player.appendChild(settingsBtn);

    const qualityMenuItem = env.document.createElement("div");
    qualityMenuItem.className = "ytp-menuitem";
    const qLabel = env.document.createElement("div");
    qLabel.className = "ytp-menuitem-label";
    qLabel.textContent = "Quality";
    qualityMenuItem.appendChild(qLabel);
    player.appendChild(qualityMenuItem);

    let clicked2160 = false;
    const opt2160 = env.document.createElement("div");
    opt2160.className = "ytp-menuitem";
    const l2160 = env.document.createElement("div");
    l2160.className = "ytp-menuitem-label";
    l2160.textContent = "2160p 4K";
    opt2160.appendChild(l2160);
    opt2160.addEventListener("click", () => { clicked2160 = true; });

    qualityMenuItem.addEventListener("click", () => {
      qualityMenuItem.remove();
      player.appendChild(opt2160);
    });

    await ctx.setQualityViaMenu(player, "Auto");
    assert.strictEqual(clicked2160, false, "Auto must not fall back to 2160p when Auto is missing");
  });

  runTest("dismissPremiumModal ignores non-Premium dialogs containing Cancel button", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const dialog = env.document.createElement("tp-yt-paper-dialog");
    const header = env.document.createElement("div");
    header.textContent = "Save video to playlist";
    const cancelBtn = env.document.createElement("button");
    cancelBtn.textContent = "Cancel";
    let cancelClicked = false;
    cancelBtn.addEventListener("click", () => { cancelClicked = true; });
    dialog.appendChild(header);
    dialog.appendChild(cancelBtn);
    env.document.body.appendChild(dialog);

    ctx.dismissPremiumModal();
    assert.strictEqual(cancelClicked, false, "Non-Premium playlist dialog must not be dismissed");
  });

  runTest("isAdPlaying guards SponsorBlock, AutoQuality, and Speed ratechange during ads", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    player.className = "html5-video-player ad-showing";
    let playbackQualityCalled = false;
    player.setPlaybackQualityRange = () => { playbackQualityCalled = true; };

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.currentTime = 15;
    video.duration = 120;
    video.readyState = 4;
    video.playbackRate = 2.0;
    player.appendChild(video);
    env.document.body.appendChild(player);

    assert.strictEqual(ctx.isAdPlaying(), true, "isAdPlaying should detect .ad-showing class on #movie_player");

    // 1. AutoQuality should defer while ad is playing
    ctx.applyQuality();
    assert.strictEqual(playbackQualityCalled, false, "applyQuality must not set quality on an active ad");

    // 2. SponsorBlock must not skip ad at currentTime = 15 even if main video has a segment [10, 30]
    ctx.state.segments = [{ segment: [10, 30], UUID: "seg-1", category: "sponsor" }];
    ctx.startSegmentMonitor();
    video.dispatchEvent({ type: "timeupdate" });
    assert.strictEqual(video.currentTime, 15, "SponsorBlock must not skip while an ad is playing");

    // 3. Speed control must not overwrite customPlaybackRate when ad resets video.playbackRate to 1.0
    ctx.state.customPlaybackRate = 2.0;
    ctx.bindSpeedVideo(video);
    video.playbackRate = 1.0;
    video.dispatchEvent({ type: "ratechange" });
    assert.strictEqual(ctx.state.customPlaybackRate, 2.0, "customPlaybackRate must be preserved across ad ratechange");
  });

  runTest("SponsorBlock backward seek prunes skippedSegments so re-watched segments skip again", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    player.className = "html5-video-player";
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.isConnected = true;
    video.paused = false;
    video.seeking = false;
    video.currentTime = 12;
    video.duration = 120;
    let frameCb = null;
    video.requestVideoFrameCallback = (cb) => {
      frameCb = cb;
      return 1;
    };
    video.cancelVideoFrameCallback = () => {};
    player.appendChild(video);
    env.document.body.appendChild(player);

    ctx.state.segments = [{ segment: [10, 30], UUID: "seg-rewind", category: "sponsor" }];
    ctx.startSegmentMonitor();

    // Trigger initial frame check at t=12 -> jumps to 30
    if (frameCb) frameCb();
    assert.strictEqual(video.currentTime, 30, "First pass should skip segment [10, 30]");
    assert.strictEqual(ctx.state.skippedSegments.has("seg-rewind"), true);

    // Simulate user seeking backward to t=5 (before segment start 10)
    video.currentTime = 5;
    video.dispatchEvent({ type: "seeked" });
    assert.strictEqual(ctx.state.skippedSegments.has("seg-rewind"), false, "Backward seek before segment start should prune UUID");
    ctx.stopSegmentMonitor();
  });

  runTest("ensureAudioPipeline rebuilds Web Audio graph when video element is replaced in DOM", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const video1 = env.document.createElement("video");
    video1.className = "html5-main-video";
    player.appendChild(video1);
    env.document.body.appendChild(player);

    ctx.ensureAudioPipeline(video1);
    assert.strictEqual(ctx.state._boostBoundVideo, video1);

    // Replace video1 with video2 in DOM
    player.removeChild(video1);
    const video2 = env.document.createElement("video");
    video2.className = "html5-main-video";
    player.appendChild(video2);

    ctx.ensureAudioPipeline(video2);
    assert.strictEqual(ctx.state._boostBoundVideo, video2, "Audio pipeline should rebind to newly mounted video element");
  });

  runTest("Fullscreen entry deactivates active mini-player on scroll or fullscreenchange", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "player";
    player.offsetHeight = 560;
    const ytdPlayer = env.document.createElement("ytd-player");
    ytdPlayer.id = "ytd-player";
    ytdPlayer.offsetHeight = 560;
    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    ytdPlayer.appendChild(moviePlayer);
    player.appendChild(ytdPlayer);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", moviePlayer);

    // Register mini-player listeners via SETTINGS_UPDATE
    ctx.state.settings.miniPlayerEnabled = false;
    env.window.dispatchEvent({
      type: "message",
      source: env.window,
      origin: "https://www.youtube.com",
      data: {
        source: "yt-adjust-isolated",
        type: "SETTINGS_UPDATE",
        payload: { miniPlayerEnabled: true },
      },
    });

    ctx.activateMiniPlayer();
    assert.strictEqual(ctx.state.miniPlayerActive, true);

    // Enter fullscreen and fire fullscreenchange listener
    env.document.fullscreenElement = ytdPlayer;
    env.document.dispatchEvent({ type: "fullscreenchange" });
    assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini-player must deactivate when fullscreenchange fires with fullscreenElement");
  });

  runTest("handleSegmentsUpdate rejects stale videoId and onNavigate clears previous segments", () => {
    const env = createDomEnvironment();
    env.window.location.search = "?v=NEW_VID_123";
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    player.appendChild(video);
    env.document.body.appendChild(player);

    // Attempt to apply segments for an old video ID while URL is NEW_VID_123
    ctx.handleSegmentsUpdate({
      videoId: "OLD_VID_999",
      segments: [{ segment: [5, 15], UUID: "old-seg", category: "sponsor" }],
    });
    assert.strictEqual(ctx.state.segments.length, 0, "Stale videoId segments must be ignored");

    // Apply segments for matching video ID
    ctx.handleSegmentsUpdate({
      videoId: "NEW_VID_123",
      segments: [{ segment: [5, 15], UUID: "new-seg", category: "sponsor" }],
    });
    assert.strictEqual(ctx.state.segments.length, 1, "Matching videoId segments must be applied");

    // Navigate to another video and verify segments are immediately cleared
    ctx.onNavigate();
    assert.strictEqual(ctx.state.segments.length, 0, "onNavigate must immediately clear previous segments");
  });

  await runTestAsync("Helium & Chrome Auto-PiP parity: window blur triggers Auto-PiP even when document.hasFocus() is true", async () => {
    const env = createDomEnvironment();
    // Simulate Helium custom shell where document.hasFocus() remains true and visibilityState is "visible" on window blur
    env.document.visibilityState = "visible";
    env.document.hidden = false;
    env.document.hasFocus = () => true;
    env.document.pictureInPictureEnabled = true;
    env.document.pictureInPictureElement = null;

    const ctx = loadMainJsInContext(env, true);
    ctx.setupPictureInPicture();

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.paused = false;
    video.ended = false;
    video.readyState = 4;
    video.currentTime = 10;
    let pipRequested = false;
    video.requestPictureInPicture = async () => {
      pipRequested = true;
      env.document.pictureInPictureElement = video;
    };
    player.appendChild(video);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    // Fire window blur (mapped to documentMock in test harness)
    env.window.dispatchEvent({ type: "blur" });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(pipRequested, true, "Auto-PiP must activate on window blur in both Chrome and Helium");
    assert.strictEqual(ctx.state.pipAutoTriggered, true);
  });

  runTest("Theater Mode (Creator Mode) scroll round-trip: never blows out past calc(100vh - 169px) or leaks minHeight", () => {
    const env = createDomEnvironment();
    env.window.innerWidth = 1536;
    env.window.innerHeight = 864;
    const ctx = loadMainJsInContext(env, true);

    // Empty #player in #primary (height: 0 in Theater Mode)
    const player = env.document.createElement("div");
    player.id = "player";
    player.offsetWidth = 0;
    player.offsetHeight = 0;
    player.clientWidth = 0;
    player.clientHeight = 0;
    player.getBoundingClientRect = () => ({ top: 695, bottom: 695, left: 0, right: 0, width: 0, height: 0 });
    env.document.body.appendChild(player);

    // #full-bleed-container constrained by max-height: calc(100vh - 169px) = 695px
    const fullBleed = env.document.createElement("div");
    fullBleed.id = "full-bleed-container";
    fullBleed.clientWidth = 1536;
    fullBleed.clientHeight = 695;
    fullBleed.offsetWidth = 1536;
    fullBleed.offsetHeight = 695;
    fullBleed.getBoundingClientRect = () => ({ top: -660, bottom: 35, left: 0, right: 1536, width: 1536, height: 695 });
    env.document.body.appendChild(fullBleed);

    const playerFullBleed = env.document.createElement("div");
    playerFullBleed.id = "player-full-bleed-container";
    playerFullBleed.clientWidth = 1536;
    playerFullBleed.clientHeight = 695;
    playerFullBleed.offsetWidth = 1536;
    playerFullBleed.offsetHeight = 695;
    fullBleed.appendChild(playerFullBleed);

    const ytdPlayer = env.document.createElement("ytd-player");
    ytdPlayer.id = "ytd-player";
    ytdPlayer.getBoundingClientRect = () => ({ top: -660, bottom: 35, left: 0, right: 1536, width: 1536, height: 695 });
    playerFullBleed.appendChild(ytdPlayer);

    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    ytdPlayer.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    const container = env.document.createElement("div");
    container.className = "html5-video-container";
    moviePlayer.appendChild(container);

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.videoWidth = 1920;
    video.videoHeight = 1080;
    // Initial pillarboxed Theater Mode dimensions inside 1536x695
    video.style.width = "1236px";
    video.style.height = "695px";
    video.style.left = "150px";
    video.style.top = "0px";
    container.appendChild(video);

    // Simulate YouTube's setInternalSize mutating video.style when called during activation or deactivation
    moviePlayer.setInternalSize = () => {
      if (ytdPlayer.style.position === "fixed") {
        video.style.width = "480px";
        video.style.height = "270px";
        video.style.left = "0px";
        video.style.top = "0px";
      } else {
        // Simulate YouTube attempting unconstrained 100vw x 56.25vw (1536x864) blowout on resize
        video.style.width = "1536px";
        video.style.height = "864px";
        video.style.left = "0px";
        video.style.top = "0px";
      }
    };

    ctx.setupMiniPlayer();
    const scrollListeners = env.eventListeners.get("scroll") || [];
    const scrollHandler = scrollListeners[0].listener;

    // 1. Scroll down past threshold (bottom = 35 < 56) -> activates mini-player
    scrollHandler();
    assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini-player activates on scroll down in Theater Mode");
    assert.strictEqual(fullBleed.style.minHeight, "695px", "Preserves exact 695px Theater Mode height while active");
    assert.strictEqual(playerFullBleed.style.minHeight, "695px", "Preserves 695px on playerFullBleed while active");
    assert.strictEqual(player.style.minHeight, undefined, "Never touches #player in Theater Mode");

    // 2. Scroll back up (bottom = 695 >= 80) -> deactivates mini-player
    fullBleed.getBoundingClientRect = () => ({ top: 0, bottom: 695, left: 0, right: 1536, width: 1536, height: 695 });
    scrollHandler();

    assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini-player deactivates on scroll up");
    assert.strictEqual(fullBleed.style.minHeight, "", "fullBleed minHeight restored to empty string");
    assert.strictEqual(playerFullBleed.style.minHeight, "", "playerFullBleed minHeight restored to empty string (never 864px)");
    assert.strictEqual(video.style.height, "695px", "Video height clamped to 695px Theater Mode container (never blows out to 864px)");
    assert.strictEqual(video.style.width, "1236px", "Video width pillarboxed to 1236px inside 1536x695");
    assert.strictEqual(video.style.left, "150px", "Video centered horizontally at 150px");
  });

  runTest("Standard Mode scroll round-trip: coexists with Theater Mode fix and restores native dimensions cleanly", () => {
    const env = createDomEnvironment();
    env.window.innerWidth = 1536;
    env.window.innerHeight = 864;
    const ctx = loadMainJsInContext(env, true);

    // Empty #full-bleed-container (height: 0 in Standard Mode)
    const fullBleed = env.document.createElement("div");
    fullBleed.id = "full-bleed-container";
    fullBleed.clientWidth = 0;
    fullBleed.clientHeight = 0;
    fullBleed.offsetWidth = 0;
    fullBleed.offsetHeight = 0;
    fullBleed.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    env.document.body.appendChild(fullBleed);

    // Active #player in Standard Mode (1000x563)
    const player = env.document.createElement("div");
    player.id = "player";
    player.clientWidth = 1000;
    player.clientHeight = 563;
    player.offsetWidth = 1000;
    player.offsetHeight = 563;
    player.getBoundingClientRect = () => ({ top: -530, bottom: 33, left: 24, right: 1024, width: 1000, height: 563 });
    env.document.body.appendChild(player);

    const playerOuter = env.document.createElement("div");
    playerOuter.id = "player-container-outer";
    player.appendChild(playerOuter);

    const playerContainer = env.document.createElement("div");
    playerContainer.id = "player-container";
    playerContainer.clientWidth = 1000;
    playerContainer.clientHeight = 563;
    playerContainer.offsetWidth = 1000;
    playerContainer.offsetHeight = 563;
    playerOuter.appendChild(playerContainer);

    const ytdPlayer = env.document.createElement("ytd-player");
    ytdPlayer.id = "ytd-player";
    ytdPlayer.getBoundingClientRect = () => ({ top: -530, bottom: 33, left: 24, right: 1024, width: 1000, height: 563 });
    playerContainer.appendChild(ytdPlayer);

    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    ytdPlayer.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    const container = env.document.createElement("div");
    container.className = "html5-video-container";
    moviePlayer.appendChild(container);

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.videoWidth = 1920;
    video.videoHeight = 1080;
    video.style.width = "1000px";
    video.style.height = "563px";
    video.style.left = "0px";
    video.style.top = "0px";
    container.appendChild(video);

    ctx.setupMiniPlayer();
    const scrollListeners = env.eventListeners.get("scroll") || [];
    const scrollHandler = scrollListeners[0].listener;

    // 1. Scroll down past threshold -> activates mini-player
    scrollHandler();
    assert.strictEqual(ctx.state.miniPlayerActive, true, "Mini-player activates in Standard Mode");
    assert.strictEqual(player.style.minHeight, "563px", "Preserves #player height while active");
    assert.strictEqual(playerOuter.style.minHeight, "563px", "Preserves #player-container-outer height while active");
    assert.strictEqual(playerContainer.style.minHeight, "563px", "Preserves #player-container height while active");
    assert.strictEqual(fullBleed.style.minHeight, undefined, "Never touches #full-bleed-container in Standard Mode");

    // 2. Scroll back up -> deactivates mini-player
    player.getBoundingClientRect = () => ({ top: 56, bottom: 619, left: 24, right: 1024, width: 1000, height: 563 });
    scrollHandler();

    assert.strictEqual(ctx.state.miniPlayerActive, false, "Mini-player deactivates on scroll up in Standard Mode");
    assert.strictEqual(player.style.minHeight, "", "#player minHeight restored to empty string");
    assert.strictEqual(playerOuter.style.minHeight, "", "#player-container-outer minHeight restored to empty string");
    assert.strictEqual(playerContainer.style.minHeight, "", "#player-container minHeight restored to empty string");
    assert.strictEqual(video.style.width, "1000px", "Standard Mode video width restored");
    assert.strictEqual(video.style.height, "563px", "Standard Mode video height restored");
    assert.strictEqual(video.style.left, "0px", "Standard Mode video left restored");
    assert.strictEqual(video.style.top, "0px", "Standard Mode video top restored");
  });

  runTest("SponsorBlock CPU optimization: halts 60fps monitor once all segments are passed and restarts on backward seek", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.isConnected = true;
    video.paused = false;
    video.seeking = false;
    video.currentTime = 15;
    video.duration = 120;

    let frameCb = null;
    let rVFCCount = 0;
    video.requestVideoFrameCallback = (cb) => {
      rVFCCount++;
      frameCb = cb;
      return rVFCCount;
    };
    video.cancelVideoFrameCallback = () => {};
    player.appendChild(video);
    env.document.body.appendChild(player);

    ctx.state.segments = [{ segment: [10, 30], UUID: "seg-only", category: "sponsor" }];
    ctx.startSegmentMonitor();
    assert.strictEqual(rVFCCount, 1, "Initial frame callback scheduled");

    // Fire frame check at t=15 -> skips [10, 30] to t=30, and since no segments remain ahead, halts loop!
    frameCb();
    assert.strictEqual(video.currentTime, 30, "Skipped segment to 30s");
    assert.strictEqual(ctx.state.skipAnimationFrame, null, "Monitor loop halted (null) once all segments are passed");
    assert.strictEqual(rVFCCount, 1, "Did NOT schedule another 60fps callback after passing final segment");

    // User seeks backward to t=5 -> seeked listener prunes UUID and restarts monitor loop automatically!
    video.currentTime = 5;
    video.dispatchEvent({ type: "seeked" });
    assert.strictEqual(ctx.state.skippedSegments.has("seg-only"), false, "UUID pruned on rewind");
    assert.notStrictEqual(ctx.state.skipAnimationFrame, null, "Monitor loop automatically restarted on rewind before segment");
  });

  runTest("Live stream guard: prevents sticky customPlaybackRate > 1.0x stall and skips seekbar overlay on live streams", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const liveBadge = env.document.createElement("span");
    liveBadge.className = "ytp-live";
    player.appendChild(liveBadge);

    const chaptersContainer = env.document.createElement("div");
    chaptersContainer.className = "ytp-chapters-container";
    player.appendChild(chaptersContainer);

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.playbackRate = 1.0;
    video.duration = 3600;
    player.appendChild(video);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    assert.strictEqual(ctx.isLiveStream(), true, "Detects live stream via .ytp-live");

    // Sticky speed 2.0x from previous VOD must NOT be forced onto live stream
    ctx.state.customPlaybackRate = 2.0;
    ctx.bindSpeedVideo(video);
    assert.strictEqual(video.playbackRate, 1.0, "Live stream playbackRate remains at 1.0x to prevent buffer stall");

    // SponsorBlock seekbar overlay must not render on live streams
    ctx.state.segments = [{ segment: [10, 60], UUID: "live-seg", category: "sponsor" }];
    ctx.renderSeekbarOverlay();
    assert.strictEqual(env.document.getElementById("yt-adjust-seekbar-overlay"), null, "No seekbar overlay on live stream");
  });

  runTest("Theater Mode toggle while mini-player is active: transfers minHeight and placeholder so scrolling up deactivates cleanly", () => {
    const env = createDomEnvironment();
    env.window.innerWidth = 1536;
    env.window.innerHeight = 864;
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "player";
    player.clientWidth = 1000;
    player.offsetHeight = 563;
    player.getBoundingClientRect = () => ({ top: -530, bottom: 33, left: 24, right: 1024, width: 1000, height: 563 });
    env.document.body.appendChild(player);

    const playerContainer = env.document.createElement("div");
    playerContainer.id = "player-container";
    player.appendChild(playerContainer);

    const fullBleed = env.document.createElement("div");
    fullBleed.id = "full-bleed-container";
    fullBleed.clientWidth = 1536;
    fullBleed.offsetHeight = 0;
    env.document.body.appendChild(fullBleed);

    const ytdPlayer = env.document.createElement("ytd-player");
    ytdPlayer.id = "ytd-player";
    playerContainer.appendChild(ytdPlayer);

    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    ytdPlayer.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    ctx.setupMiniPlayer();
    ctx.activateMiniPlayer();
    assert.strictEqual(ctx.state.miniPlayerActive, true);
    assert.strictEqual(ctx.state._miniPlayerAnchor, player, "Anchor initially set to #player");
    assert.strictEqual(player.style.minHeight, "563px");

    // Simulate user pressing 't' while mini-player is floating: YouTube moves ytdPlayer into fullBleed
    fullBleed.offsetHeight = 695;
    fullBleed.appendChild(ytdPlayer);
    ctx.syncMiniPlayerTheaterToggle(ytdPlayer);

    assert.strictEqual(ctx.state._miniPlayerAnchor, fullBleed, "Anchor transferred to #full-bleed-container");
    assert.strictEqual(player.style.minHeight, "", "Cleared minHeight from now-inactive #player");
    assert.strictEqual(fullBleed.style.minHeight, "695px", "Applied clamped 695px minHeight to #full-bleed-container");
  });

  runTest("Monotone seekbar markers & Configurable Volume Boost (150% / 200% / 300%)", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const moviePlayer = env.document.createElement("div");
    moviePlayer.id = "movie_player";
    const chaptersContainer = env.document.createElement("div");
    chaptersContainer.className = "ytp-chapters-container";
    moviePlayer.appendChild(chaptersContainer);

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.duration = 200;
    video.volume = 0.5;
    moviePlayer.appendChild(video);
    env.document.body.appendChild(moviePlayer);
    env.elements.set("movie_player", moviePlayer);

    ctx.state.segments = [
      { segment: [10, 30], category: "sponsor", UUID: "u-spon" },
      { segment: [50, 70], category: "selfpromo", UUID: "u-promo" }
    ];
    ctx.renderSeekbarOverlay();

    const overlay = env.document.getElementById("yt-adjust-seekbar-overlay");
    assert.ok(overlay, "Seekbar overlay mounted");
    assert.strictEqual(overlay.children[0].style.backgroundColor, "#fff", "Sponsor marker uses monotone #fff");
    assert.strictEqual(overlay.children[0].style.opacity, "0.35", "Sponsor marker uses 0.35 resting opacity");
    assert.strictEqual(overlay.children[0].title, "Sponsor (20s)", "Sponsor marker has tooltip title");
    assert.strictEqual(overlay.children[1].style.backgroundColor, "#fff", "Self-promo marker uses monotone #fff");

    // Configurable Volume Boost: switch to 200% (2.0) and 300% (3.0)
    ctx.state.settings.volumeBoostLevel = 2;
    ctx.toggleBoost();
    assert.strictEqual(ctx.state.boostActive, true);
    assert.strictEqual(ctx.state.gainNode.gain.value, 2, "Gain set to 200% (2.0)");

    ctx.handleSettingsUpdate({ volumeBoostLevel: 3 });
    assert.strictEqual(ctx.state.gainNode.gain.value, 3, "Live settings update adjusts gainNode to 300% (3.0)");
  });

  await runTestAsync("Auto-PiP tab return: restores inline video surface and blocks spurious window blur from re-entering PiP", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.state.settings.pipEnabled = true;
    ctx.state.settings.pipAutoOnTabSwitch = true;
    ctx.setupPictureInPicture();
    ctx.bindPipVideo(dom.video);

    // 1. User switches away from tab -> Auto-PiP activates
    env.document.visibilityState = "hidden";
    env.document.hidden = true;
    env.document.dispatchEvent({ type: "visibilitychange" });
    await new Promise((r) => setImmediate(r));
    dom.video.dispatchEvent({ type: "enterpictureinpicture" });
    assert.strictEqual(ctx.state.pipNeedsSurfaceRestore, true, "Marks video surface for restoration on PiP entry");

    // 2. Simulate browser-native AutoPictureInPictureTabHelper closing the PiP window while tab is still transitioning
    env.document.pictureInPictureElement = null;
    dom.video.dispatchEvent({ type: "leavepictureinpicture" });
    assert.strictEqual(ctx.state.pipNeedsSurfaceRestore, true, "Preserves pipNeedsSurfaceRestore while document is still hidden");

    // 3. Now tab becomes visible -> must run forceExitYouTubePipState and restore inline surface even though pictureInPictureElement is already null
    env.document.visibilityState = "visible";
    env.document.hidden = false;
    env.document.dispatchEvent({ type: "visibilitychange" });
    assert.strictEqual(ctx.state.pipNeedsSurfaceRestore, false, "Restores inline Blink LayoutVideo surface once tab becomes visible");
    assert.strictEqual(dom.video.style.opacity, "1");
    assert.strictEqual(dom.video.style.visibility, "visible");

    // 4. Simulate OS window manager firing transient window blur within 800ms as the PiP window is destroyed
    const reqCountBeforeBlur = dom.getPipRequested();
    env.window.dispatchEvent({ type: "blur" });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dom.getPipRequested(), reqCountBeforeBlur, "Transient window blur within 800ms of PiP exit must NOT re-enter Auto-PiP");
  });

  await runTestAsync("Cross-Tab Playback Sync (pauseOtherTabsEnabled): off by default, pauses other tabs and exits Auto-PiP when enabled", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);

    // 1. Verify off by default
    assert.strictEqual(ctx.state.settings.pauseOtherTabsEnabled, false, "pauseOtherTabsEnabled must default to false");

    // Playing video while pauseOtherTabsEnabled is false must NOT broadcast TAB_PLAYBACK_STARTED
    let broadcastedMessages = [];
    env.window.postMessage = (msg) => {
      if (msg && msg.source === "yt-adjust-main" && msg.type === "TAB_PLAYBACK_STARTED") {
        broadcastedMessages.push(msg);
      }
    };
    dom.video.paused = false;
    ctx.onDocumentVideoPlay({ target: dom.video });
    assert.strictEqual(broadcastedMessages.length, 0, "Does not broadcast when pauseOtherTabsEnabled is false");

    // 2. Enable pauseOtherTabsEnabled
    ctx.state.settings.pauseOtherTabsEnabled = true;
    ctx.onDocumentVideoPlay({ target: dom.video });
    assert.strictEqual(broadcastedMessages.length, 1, "Broadcasts TAB_PLAYBACK_STARTED when video plays and feature is enabled");

    // 3. Simulate receiving PAUSE_FROM_OTHER_TAB from another YouTube tab while this tab's video is playing in Auto-PiP
    let videoPauseCalled = false;
    let playerPauseCalled = false;
    dom.video.paused = false;
    dom.video.pause = () => {
      videoPauseCalled = true;
      dom.video.paused = true;
    };
    const moviePlayer = env.document.getElementById("movie_player");
    moviePlayer.getPlayerState = () => 1;
    moviePlayer.pauseVideo = () => {
      playerPauseCalled = true;
    };
    env.document.pictureInPictureElement = dom.video;
    ctx.state.pipAutoTriggered = true;

    env.window.dispatchEvent({
      type: "message",
      source: env.window,
      origin: "https://www.youtube.com",
      data: {
        source: "yt-adjust-isolated",
        type: "PAUSE_FROM_OTHER_TAB",
        payload: { tabId: "other-tab-999" },
      },
    });
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(videoPauseCalled, true, "Pauses HTML5 video element when another tab starts playing");
    assert.strictEqual(playerPauseCalled, true, "Calls YouTube player.pauseVideo() when another tab starts playing");
    assert.strictEqual(dom.getPipExited(), 1, "Exits Auto-PiP on background tab when paused by another tab");
  });

  await runTestAsync("Pre-hydration autoplay race: playing video before SETTINGS_UPDATE arrives broadcasts TAB_PLAYBACK_STARTED immediately on hydration and on timeupdate", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);
    ctx.setupMultiTabSync();

    let broadcastedMessages = [];
    env.window.postMessage = (msg) => {
      if (msg && msg.source === "yt-adjust-main" && msg.type === "TAB_PLAYBACK_STARTED") {
        broadcastedMessages.push(msg);
      }
    };

    // 1. Video starts autoplaying BEFORE isolated.js finishes reading chrome.storage (pauseOtherTabsEnabled is still false)
    dom.video.paused = false;
    dom.video.ended = false;
    ctx.onDocumentVideoPlay({ target: dom.video });
    assert.strictEqual(broadcastedMessages.length, 0, "Not broadcasted while pauseOtherTabsEnabled is false");
    assert.strictEqual(ctx.state._pendingPlayAnnouncement, true, "Queues _pendingPlayAnnouncement for pre-hydration autoplay");

    // 2. SETTINGS_UPDATE arrives from isolated.js with pauseOtherTabsEnabled: true
    ctx.handleSettingsUpdate({ pauseOtherTabsEnabled: true });
    assert.strictEqual(broadcastedMessages.length, 1, "Immediately broadcasts TAB_PLAYBACK_STARTED once SETTINGS_UPDATE enables pauseOtherTabsEnabled");
    assert.strictEqual(ctx.state._hasAnnouncedCurrentPlayback, true, "Marks current playback session as announced");

    // 3. Subsequent timeupdate events during the same continuous playback session must NOT spam broadcasts
    ctx.onDocumentVideoTimeUpdate({ target: dom.video });
    assert.strictEqual(broadcastedMessages.length, 1, "Does not spam TAB_PLAYBACK_STARTED on subsequent timeupdate ticks");

    // 4. Video pauses and resumes -> broadcasts again on next play/timeupdate
    ctx.onDocumentVideoPauseOrEnded({ target: dom.video });
    assert.strictEqual(ctx.state._hasAnnouncedCurrentPlayback, false, "Resets _hasAnnouncedCurrentPlayback on pause");
    ctx.onDocumentVideoTimeUpdate({ target: dom.video });
    assert.strictEqual(broadcastedMessages.length, 2, "Broadcasts TAB_PLAYBACK_STARTED when video resumes via timeupdate detection");
  });

  await runTestAsync("Orphaned Blink :picture-in-picture state recovery: forceExitYouTubePipState cycles request/exit when video matches :picture-in-picture with null pictureInPictureElement", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);
    const dom = setupPipDom(env);

    // Simulate Blink C++ orphaned state: document.pictureInPictureElement is null, tab is visible,
    // but video.matches(":picture-in-picture") is still true ("Playing in picture-in-picture" stuck interstitial)
    env.document.pictureInPictureElement = null;
    env.document.visibilityState = "visible";
    env.document.hidden = false;
    let isStuckInPipPseudoClass = true;
    dom.video.matches = (sel) => sel === ":picture-in-picture" && isStuckInPipPseudoClass;

    const origExit = env.document.exitPictureInPicture.bind(env.document);
    env.document.exitPictureInPicture = () => {
      isStuckInPipPseudoClass = false;
      return origExit();
    };

    ctx.forceExitYouTubePipState(false);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(dom.getPipRequested(), 1, "Calls requestPictureInPicture to re-bind orphaned Blink PiP session");
    assert.strictEqual(dom.getPipExited(), 1, "Immediately calls exitPictureInPicture to force Blink OnExitedPictureInPicture()");
    assert.strictEqual(isStuckInPipPseudoClass, false, "Clears stuck :picture-in-picture state");
  });

  await runTestAsync("Silent player API quality selection: uses getAvailableQualityLevels + setPlaybackQualityRange without clicking settings menu", async () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    let settingsBtnClicked = false;
    const settingsBtn = env.document.createElement("button");
    settingsBtn.className = "ytp-settings-button";
    settingsBtn.addEventListener("click", () => {
      settingsBtnClicked = true;
    });
    player.appendChild(settingsBtn);

    let qualityRangeCalledWith = null;
    let qualityCalledWith = null;
    player.getAvailableQualityLevels = () => ["hd1080", "hd720", "large", "medium", "small", "tiny", "auto"];
    player.setPlaybackQuality = (q) => {
      qualityCalledWith = q;
    };
    player.setPlaybackQualityRange = (minQ, maxQ) => {
      qualityRangeCalledWith = [minQ, maxQ];
    };

    // Request 4K (highres) on a video whose max available resolution is 1080p (hd1080)
    ctx.state.settings.qualityEnabled = true;
    ctx.state.settings.quality = "highres";
    await ctx.applyQuality();

    assert.strictEqual(settingsBtnClicked, false, "Must NEVER click .ytp-settings-button when player API is available");
    assert.strictEqual(qualityCalledWith, "hd1080", "Resolves highest available tier (hd1080) below highres");
    assert.deepStrictEqual(qualityRangeCalledWith, ["hd1080", "hd1080"], "Calls setPlaybackQualityRange('hd1080', 'hd1080')");

    // Verify localStorage["yt-player-quality"] uses YouTube's double-stringified numeric height schema
    const rawStored = env.window.localStorage.getItem("yt-player-quality");
    assert.ok(rawStored, "Writes yt-player-quality to localStorage");
    const outer = JSON.parse(rawStored);
    const inner = JSON.parse(outer.data);
    assert.strictEqual(inner.quality, 1080, "Stores numeric height 1080 in nested JSON data");
    assert.strictEqual(inner.previousQuality, 1080, "Stores previousQuality 1080 in nested JSON data");
  });

  runTest("YouTube 'Hold for 2x' Speedmaster (.ytp-speedmaster-overlay): preserves custom speed and restores it on release", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const speedmasterOverlay = env.document.createElement("div");
    speedmasterOverlay.className = "ytp-speedmaster-overlay";
    speedmasterOverlay.clientWidth = 0;
    player.appendChild(speedmasterOverlay);

    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.playbackRate = 1.0;
    player.appendChild(video);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    // 1. User has custom speed 1.5x
    ctx.state.customPlaybackRate = 1.5;
    ctx.bindSpeedVideo(video);
    assert.strictEqual(video.playbackRate, 1.5);
    assert.strictEqual(video.defaultPlaybackRate, 1.5);

    // 2. User holds down left-click/Spacebar -> YouTube shows .ytp-speedmaster-overlay and sets playbackRate = 2.0
    speedmasterOverlay.clientWidth = 120;
    video.playbackRate = 2.0;
    video.dispatchEvent({ type: "ratechange" });
    assert.strictEqual(ctx.state._speedmasterRestoreRate, 1.5, "Saves custom speed 1.5x during Speedmaster 2x hold");

    // 3. User releases left-click/Spacebar -> YouTube hides overlay and resets video.playbackRate to 1.0
    speedmasterOverlay.clientWidth = 0;
    video.playbackRate = 1.0;
    video.dispatchEvent({ type: "ratechange" });
    assert.strictEqual(video.playbackRate, 1.5, "Immediately restores 1.5x custom speed after Speedmaster release");
    assert.strictEqual(ctx.state.customPlaybackRate, 1.5, "Preserves state.customPlaybackRate = 1.5");
  });

  runTest("SponsorBlock: chains contiguous/overlapping segments in a single seek and re-arms 0.0s intro segments on rewind", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    video.paused = false;
    video.seeking = false;
    video.duration = 120;
    video.currentTime = 0;

    let frameCb = null;
    video.requestVideoFrameCallback = (cb) => {
      frameCb = cb;
      return 1;
    };
    video.cancelVideoFrameCallback = () => {};

    player.appendChild(video);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    // Two contiguous segments starting at 0.0s: [0, 12] (intro) + [12, 30] (sponsor)
    ctx.state.settings.sponsorblockEnabled = true;
    ctx.state.segments = [
      { segment: [0, 12], category: "intro", UUID: "seg-intro-0" },
      { segment: [12, 30], category: "sponsor", UUID: "seg-sponsor-12" },
    ];

    ctx.startSegmentMonitor();
    assert.ok(frameCb, "Registered requestVideoFrameCallback");

    // 1. Run frame check at 0.0s -> must chain [0, 12] and [12, 30] into a single jump to 30s
    frameCb();
    assert.strictEqual(video.currentTime, 30, "Chained contiguous [0, 12] and [12, 30] segments into a single seek to 30s");
    assert.strictEqual(ctx.state.skippedSegments.has("seg-intro-0"), true);
    assert.strictEqual(ctx.state.skippedSegments.has("seg-sponsor-12"), true);

    // 2. User rewinds back to 0.0s -> 0.0s segment must be pruned from skippedSegments so it can skip again
    video.currentTime = 0;
    video.dispatchEvent({ type: "seeked" });
    assert.strictEqual(ctx.state.skippedSegments.has("seg-intro-0"), false, "0.0s segment pruned on rewind to 0.0s");
    assert.strictEqual(ctx.state.skippedSegments.has("seg-sponsor-12"), false, "12s segment pruned on rewind to 0.0s");
  });

  runTest("Mini-player timestamp link interception: clicking same-video ?v=...&t=95s seeks in-place without scrolling to top", () => {
    const env = createDomEnvironment();
    const ctx = loadMainJsInContext(env, true);

    const player = env.document.createElement("div");
    player.id = "movie_player";
    let soughtTo = null;
    player.seekTo = (sec) => {
      soughtTo = sec;
    };
    const video = env.document.createElement("video");
    video.className = "html5-main-video";
    player.appendChild(video);
    env.document.body.appendChild(player);
    env.elements.set("movie_player", player);

    ctx.state.settings.miniPlayerEnabled = true;
    ctx.state.miniPlayerActive = true;
    ctx.state.currentVideoId = "dQw4w9WgXcQ";
    ctx.setupMiniPlayer();

    const link = env.document.createElement("a");
    link.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=95s";
    env.document.body.appendChild(link);

    let defaultPrevented = false;
    env.document.dispatchEvent({
      type: "click",
      target: link,
      preventDefault() {
        defaultPrevented = true;
      },
      stopImmediatePropagation() {},
    });

    assert.strictEqual(defaultPrevented, true, "Prevents default navigation/scroll-to-top when mini-player is active");
    assert.strictEqual(soughtTo, 95, "Seeks player directly to 95s in-place");
    assert.strictEqual(video.currentTime, 95, "Updates video.currentTime to 95s");
  });

  console.log(`\nStress test suite completed: ${passedTests}/${totalTests} tests passed.`);
  if (passedTests === totalTests) {
    console.log("ALL TESTS PASSED SUCCESSFULLY.");
    process.exit(0);
  } else {
    console.error("SOME TESTS FAILED.");
    process.exit(1);
  }
})();

