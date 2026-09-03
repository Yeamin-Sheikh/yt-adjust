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
      this.textContent = "";
      this.title = "";
      this.listeners = new Map();
      this.isConnected = true;
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
      const search = (node) => {
        for (const c of node.children) {
          if (selector.startsWith("#") && c.id === selector.slice(1)) return c;
          if (selector.startsWith(".") && c.className && c.className.split(/\s+/).includes(selector.slice(1))) return c;
          if (c.tagName.toLowerCase() === selector.toLowerCase()) return c;
          const found = search(c);
          if (found) return found;
        }
        return null;
      };
      return search(this);
    }

    querySelectorAll(selector) {
      const results = [];
      const search = (node) => {
        for (const c of node.children) {
          if (selector.startsWith("#") && c.id === selector.slice(1)) results.push(c);
          else if (selector.startsWith(".") && c.className && c.className.includes(selector.slice(1))) results.push(c);
          else if (c.tagName.toLowerCase() === selector.toLowerCase()) results.push(c);
          search(c);
        }
      };
      search(this);
      return results;
    }

    closest(selector) {
      let curr = this;
      while (curr) {
        if (selector.startsWith("#") && curr.id === selector.slice(1)) return curr;
        if (selector.startsWith(".") && curr.className && curr.className.includes(selector.slice(1))) return curr;
        if (curr.tagName.toLowerCase() === selector.toLowerCase()) return curr;
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

  // Match active code occurrences, excluding comments
  const innerHtmlRegex = /(?<!\/\/.*)(?<!\/\*[\s\S]*?)(innerHTML|outerHTML|insertAdjacentHTML)\s*(=|\()/;

  for (const f of files) {
    // Strip block comments and line comments for clean check
    const cleanCode = f.code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
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

  console.log(`\nStress test suite completed: ${passedTests}/${totalTests} tests passed.`);
  if (passedTests === totalTests) {
    console.log("ALL TESTS PASSED SUCCESSFULLY.");
    process.exit(0);
  } else {
    console.error("SOME TESTS FAILED.");
    process.exit(1);
  }
})();

