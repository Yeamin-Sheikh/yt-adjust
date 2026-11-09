// =============================================================================
// YT Adjust — Isolated World Content Script (v2.4.5)
// =============================================================================
// This script runs in Chrome's ISOLATED execution world.
// In Manifest V3, an isolated world content script shares the DOM with the web
// page but maintains an independent JavaScript execution context.
//
// Architectural separation and responsibilities:
// 1. Chrome Extension API access:
//    The isolated world has direct access to chrome.storage and chrome.runtime.
//    The main world has no access to extension APIs.
// 2. Network and Content Security Policy:
//    YouTube enforces a strict Content Security Policy (CSP) blocking external
//    network requests from page scripts. Because the isolated world executes in
//    an extension context with host permissions for https://sponsor.ajay.app/*,
//    it can fetch SponsorBlock segments without being blocked by YouTube's CSP.
// 3. Page internal access:
//    The isolated world cannot access YouTube player JavaScript instances or
//    custom properties attached to window (such as #movie_player APIs).
//    Therefore, all DOM rendering, seekbar highlights, speed controls, and video
//    playback skipping reside in content/main.js.
// 4. Cross-world communication bridge:
//    Data synchronization occurs via window.postMessage with origin checks
//    (window.location.origin) to prevent cross-origin message leaks.
// =============================================================================

"use strict";


// ---------------------------------------------------------------------------
// Default settings — must match popup/popup.js defaults exactly
// ---------------------------------------------------------------------------
/** @type {ExtensionSettings} */
const DEFAULTS = {
  qualityEnabled: true,
  quality: "hd1080",
  sponsorblockEnabled: true,
  sponsorblockCategories: ["sponsor", "selfpromo", "interaction"],
  sponsorblockNotify: true,
  volumeGestureEnabled: true,
  volumeStep: 5,
  speedControlEnabled: true,
  speedStep: 0.25,
  volumeBoostEnabled: true,
  volumeBoostLevel: 1.5,
  miniPlayerEnabled: true,
  pipEnabled: true,
  pipAutoOnTabSwitch: true,
  pauseOtherTabsEnabled: false,
};

const ISO_VALID_QUALITIES = ["highres", "hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny", "auto"];
const ISO_VALID_SPEED_STEPS = [0.1, 0.25, 0.5];
const ISO_VALID_BOOST_LEVELS = [1.5, 2, 3];

/**
 * Normalizes and validates raw storage values against DEFAULTS so both Chrome
 * and Helium receive strictly typed settings with zero discrepancy.
 *
 * @param {any} raw
 * @returns {ExtensionSettings}
 */
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") {
    return /** @type {ExtensionSettings} */ ({ ...DEFAULTS });
  }
  const merged = { ...DEFAULTS, ...raw };
  const normalizedQuality = merged.quality === "hd2160" ? "highres" : merged.quality;
  const volumeStepNum = Number(merged.volumeStep);
  const speedStepNum = Number(merged.speedStep);
  const boostLevelNum = Number(merged.volumeBoostLevel);
  return {
    qualityEnabled: typeof merged.qualityEnabled === "boolean" ? merged.qualityEnabled : Boolean(merged.qualityEnabled),
    quality:
      typeof normalizedQuality === "string" && ISO_VALID_QUALITIES.includes(normalizedQuality)
        ? normalizedQuality
        : DEFAULTS.quality,
    sponsorblockEnabled:
      typeof merged.sponsorblockEnabled === "boolean" ? merged.sponsorblockEnabled : Boolean(merged.sponsorblockEnabled),
    sponsorblockCategories: Array.isArray(merged.sponsorblockCategories)
      ? merged.sponsorblockCategories.filter(
          /** @param {any} c */
          (c) => typeof c === "string" && c.length > 0
        )
      : [...DEFAULTS.sponsorblockCategories],
    sponsorblockNotify:
      typeof merged.sponsorblockNotify === "boolean" ? merged.sponsorblockNotify : Boolean(merged.sponsorblockNotify),
    volumeGestureEnabled:
      typeof merged.volumeGestureEnabled === "boolean" ? merged.volumeGestureEnabled : Boolean(merged.volumeGestureEnabled),
    volumeStep:
      typeof merged.volumeStep === "number" && Number.isFinite(volumeStepNum) && volumeStepNum >= 1 && volumeStepNum <= 10
        ? Math.round(volumeStepNum)
        : DEFAULTS.volumeStep,
    speedControlEnabled:
      typeof merged.speedControlEnabled === "boolean" ? merged.speedControlEnabled : Boolean(merged.speedControlEnabled),
    speedStep:
      typeof merged.speedStep === "number" && Number.isFinite(speedStepNum) && ISO_VALID_SPEED_STEPS.includes(speedStepNum)
        ? speedStepNum
        : DEFAULTS.speedStep,
    volumeBoostEnabled:
      typeof merged.volumeBoostEnabled === "boolean" ? merged.volumeBoostEnabled : Boolean(merged.volumeBoostEnabled),
    volumeBoostLevel:
      Number.isFinite(boostLevelNum) && ISO_VALID_BOOST_LEVELS.includes(boostLevelNum)
        ? boostLevelNum
        : DEFAULTS.volumeBoostLevel,
    miniPlayerEnabled:
      typeof merged.miniPlayerEnabled === "boolean" ? merged.miniPlayerEnabled : Boolean(merged.miniPlayerEnabled),
    pipEnabled: typeof merged.pipEnabled === "boolean" ? merged.pipEnabled : Boolean(merged.pipEnabled),
    pipAutoOnTabSwitch:
      typeof merged.pipAutoOnTabSwitch === "boolean" ? merged.pipAutoOnTabSwitch : Boolean(merged.pipAutoOnTabSwitch),
    pauseOtherTabsEnabled:
      typeof merged.pauseOtherTabsEnabled === "boolean"
        ? merged.pauseOtherTabsEnabled
        : Boolean(merged.pauseOtherTabsEnabled),
  };
}

// SponsorBlock API base URL (public segment query endpoint)
/** @type {string} */
const SB_API_BASE = "https://sponsor.ajay.app/api";

// Cache fetched segments to avoid duplicate API calls when navigating
// back to a previously watched video in the same session.
// Key format: `${videoId}:${sortedCategories}`
/** @type {Map<string, SponsorBlockSegment[]>} */
const segmentCache = new Map();
const MAX_CACHE_ENTRIES = 50;

// Deduplicate concurrent in-flight SponsorBlock API requests for the same cache key.
// Prevents initialize() and REQUEST_SEGMENTS from firing duplicate HTTP fetches on page load.
/** @type {Map<string, Promise<SponsorBlockSegment[]>>} */
const inFlightRequests = new Map();

/**
 * Safely caches segments while keeping memory consumption bounded.
 * Refreshes insertion order when updating an existing key and evicts the oldest
 * entry only when inserting a new key at capacity.
 *
 * @param {string} key
 * @param {SponsorBlockSegment[]} value
 * @returns {void}
 */
function setInSegmentCache(key, value) {
  if (segmentCache.has(key)) {
    segmentCache.delete(key);
  } else if (segmentCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = segmentCache.keys().next().value;
    if (oldestKey) segmentCache.delete(oldestKey);
  }
  segmentCache.set(key, value);
}

// Track the current video ID to avoid re-fetching on duplicate nav events.
// YouTube SPA transitions often fire multiple navigation signals during
// ad transitions or layout updates.
/** @type {string | null} */
let currentVideoId = null;

// ---------------------------------------------------------------------------
// Extension context & storage helpers
// ---------------------------------------------------------------------------
/**
 * Verifies whether the extension execution context is still valid.
 * When an extension is reloaded or updated in developer mode, existing content
 * scripts in open tabs become orphaned. In Chromium, chrome.runtime.id becomes
 * undefined, and calling chrome APIs throws "Extension context invalidated".
 *
 * @returns {boolean} True if context is active or running in tests, false if invalidated
 */
function isExtensionContextValid() {
  try {
    if (typeof chrome === "undefined") return false;
    if (chrome?.runtime) {
      if (!chrome.runtime.id) return false;
      // In Chromium, accessing chrome.runtime.getManifest() throws synchronously
      // when the extension execution context has been invalidated.
      if (typeof chrome.runtime.getManifest === "function") {
        const manifest = chrome.runtime.getManifest();
        if (!manifest) return false;
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// In-memory settings cache to avoid redundant chrome.storage IPC calls on SPA navigations
/** @type {ExtensionSettings | null} */
let cachedSettings = null;

/**
 * Loads stored extension settings with layered fallbacks and in-memory caching.
 * Tries chrome.storage.sync first. If sync is unavailable or throws
 * (for example, when browser synchronization is disabled or when the extension
 * context is invalidated during a live extension reload), it falls back to
 * chrome.storage.local. If local storage is also unavailable, it returns DEFAULTS.
 * Suppresses console output on context invalidation to prevent error badges in Chromium.
 *
 * @param {boolean} [forceRefresh=false] - Bypass in-memory cache when storage changes
 * @returns {Promise<ExtensionSettings>} Resolved settings object
 */
async function getSettings(forceRefresh = false) {
  if (!forceRefresh && cachedSettings) {
    return /** @type {ExtensionSettings} */ ({ ...cachedSettings });
  }

  if (!isExtensionContextValid()) {
    return /** @type {ExtensionSettings} */ ({ ...(cachedSettings || DEFAULTS) });
  }

  // Attempt 1: chrome.storage.sync
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.sync?.get) {
      const syncData = await chrome.storage.sync.get(DEFAULTS);
      if (syncData && typeof syncData === "object") {
        const sanitized = sanitizeSettings(syncData);
        cachedSettings = sanitized;
        return /** @type {ExtensionSettings} */ ({ ...sanitized });
      }
    }
  } catch (syncError) {
    if (
      isExtensionContextValid() &&
      !(syncError instanceof Error && syncError.message.includes("Extension context invalidated"))
    ) {
      console.log("[YT Adjust] chrome.storage.sync access failed, trying local storage:", syncError);
    }
  }

  // Attempt 2: chrome.storage.local fallback
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
      const localData = await chrome.storage.local.get(DEFAULTS);
      if (localData && typeof localData === "object") {
        const sanitized = sanitizeSettings(localData);
        cachedSettings = sanitized;
        return /** @type {ExtensionSettings} */ ({ ...sanitized });
      }
    }
  } catch (localError) {
    if (
      isExtensionContextValid() &&
      !(localError instanceof Error && localError.message.includes("Extension context invalidated"))
    ) {
      console.log("[YT Adjust] chrome.storage.local access failed, using defaults:", localError);
    }
  }

  // Attempt 3: In-memory fallback defaults
  const fallback = /** @type {ExtensionSettings} */ ({ ...DEFAULTS });
  cachedSettings = fallback;
  return /** @type {ExtensionSettings} */ ({ ...fallback });
}

// ---------------------------------------------------------------------------
// Utility: extract video ID from the current URL
// ---------------------------------------------------------------------------
/**
 * Extracts the 11-character YouTube video ID from the URL search query on /watch pages.
 * Restricted to standard watch pages to align with content/main.js lifecycle and avoid
 * unnecessary SponsorBlock API requests on YouTube Shorts.
 *
 * @returns {string | null} The video identifier or null if not on a watch page
 */
function getVideoId() {
  if (window.location.pathname && window.location.pathname !== "/watch" && !window.location.search.includes("v=")) {
    return null;
  }
  // Check standard watch query parameter ?v=
  const params = new URLSearchParams(window.location.search);
  const queryId = params.get("v");
  if (queryId) return queryId;

  return null;
}

// ---------------------------------------------------------------------------
// Utility: compute SHA-256 hash prefix for privacy-friendly API calls
// ---------------------------------------------------------------------------
/**
 * Computes the first N hex characters of SHA-256(videoId).
 *
 * K-anonymity privacy design:
 * Instead of sending the full video ID to SponsorBlock's external server,
 * we send only a 4-character hex hash prefix. The server returns all video
 * records sharing that 4-character prefix (typically several dozen videos).
 * We then filter for our target videoID client-side.
 * This ensures the remote server cannot identify the exact video watched by the user.
 *
 * @param {string} text - The input text (video ID) to hash
 * @param {number} [prefixLength=4] - Number of leading hex characters to return
 * @returns {Promise<string>} Leading hex characters of the SHA-256 digest
 */
async function sha256Prefix(text, prefixLength = 4) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.substring(0, prefixLength);
}

// ---------------------------------------------------------------------------
// Fetch SponsorBlock segments for a given video ID
// ---------------------------------------------------------------------------
/**
 * Queries the SponsorBlock skipSegments hash-prefix endpoint with a timeout.
 *
 * Includes defensive validations:
 * - 5000ms AbortController timeout prevents stalled network requests from hanging.
 * - Checks HTTP 404 cleanly (indicating no segments submitted for this video).
 * - Validates that the response payload is an array before iteration.
 * - Validates segment structure before sorting by start time.
 *
 * @param {string} videoId - Target YouTube video identifier
 * @param {string[]} categories - Array of category strings to filter
 * @returns {Promise<SponsorBlockSegment[]>} Sorted array of matching skip segments
 */
async function fetchSegments(videoId, categories) {
  if (!videoId || typeof videoId !== "string" || !Array.isArray(categories) || categories.length === 0) {
    return [];
  }

  // Check in-memory cache first to avoid redundant API queries
  const sortedCategories = [...categories].sort();
  const cacheKey = `${videoId}:${sortedCategories.join(",")}`;
  if (segmentCache.has(cacheKey)) {
    return segmentCache.get(cacheKey) || [];
  }

  // If a superset of the requested categories is already cached for this videoId,
  // filter it client-side in O(N) with zero network round-trips
  const prefix = `${videoId}:`;
  for (const [existingKey, existingSegments] of segmentCache.entries()) {
    if (existingKey.startsWith(prefix) && Array.isArray(existingSegments)) {
      const cachedCats = existingKey.slice(prefix.length).split(",");
      if (sortedCategories.every((cat) => cachedCats.includes(cat))) {
        const filtered = existingSegments.filter((s) => s && sortedCategories.includes(s.category));
        setInSegmentCache(cacheKey, filtered);
        return filtered;
      }
    }
  }

  // Reuse in-flight request Promise if an identical query is already awaiting network I/O
  const existingRequest = inFlightRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const requestPromise = (async () => {
    // Set up an AbortController with a 5-second timeout window
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const hashPrefix = await sha256Prefix(videoId);

      // Build the API URL with category, action type, and UUID trimming filters
      const categoriesParam = encodeURIComponent(JSON.stringify(categories));
      const url = `${SB_API_BASE}/skipSegments/${hashPrefix}?categories=${categoriesParam}&actionTypes=${encodeURIComponent('["skip"]')}&trimUUIDs=5`;

      /** @type {any} */
      let data = null;

      // In Manifest V3, content scripts execute inside the host page frame
      // (https://www.youtube.com) and cannot issue cross-origin fetch() calls
      // directly without triggering a frame-origin security error. Route the
      // request through the extension's background service worker via
      // chrome.runtime.sendMessage whenever available.
      if (
        typeof chrome !== "undefined" &&
        chrome.runtime &&
        typeof chrome.runtime.sendMessage === "function"
      ) {
        clearTimeout(timeoutId);
        /** @type {any} */
        let msgTimeoutId = null;
        const msgTimeoutPromise = new Promise((resolve) => {
          msgTimeoutId = setTimeout(() => {
            resolve({ ok: false, status: 0, error: "AbortError" });
          }, 5500);
        });

        const bgResponse = await Promise.race([
          chrome.runtime.sendMessage({
            type: "FETCH_SPONSORBLOCK",
            url,
          }),
          msgTimeoutPromise,
        ]);
        if (msgTimeoutId) clearTimeout(msgTimeoutId);

        if (!bgResponse || typeof bgResponse !== "object") {
          return [];
        }

        if (bgResponse.error === "AbortError") {
          console.warn(`[YT Adjust] SponsorBlock request timed out for video ${videoId}`);
          return [];
        }

        if (bgResponse.status === 404) {
          setInSegmentCache(cacheKey, []);
          return [];
        }

        if (!bgResponse.ok) {
          console.log(
            `[YT Adjust] SponsorBlock API returned status ${bgResponse.status || bgResponse.error || "error"}`
          );
          return [];
        }

        data = bgResponse.data;
      } else {
        // Fallback for standalone VM unit test sandboxes that mock global fetch() directly
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        // 404 indicates no segments exist in the database for videos matching this prefix
        if (response.status === 404) {
          setInSegmentCache(cacheKey, []);
          return [];
        }

        if (!response.ok) {
          console.log(`[YT Adjust] SponsorBlock API returned HTTP ${response.status}`);
          return [];
        }

        data = await response.json();
      }

      // Verify response format: the hash-prefix endpoint returns an array of video entries
      if (!Array.isArray(data)) {
        console.warn("[YT Adjust] SponsorBlock response payload is not an array:", data);
        return [];
      }

      // Filter to find segments matching our exact video ID client-side
      /** @type {SponsorBlockSegment[]} */
      let segments = [];
      for (const entry of data) {
        if (entry && entry.videoID === videoId && Array.isArray(entry.segments)) {
          // Validate each segment item defensively before passing to cache or main world
          segments = entry.segments
            .filter(
              /**
               * Type guard checks segment object structure and finite numeric bounds.
               *
               * @param {any} s
               * @returns {s is SponsorBlockSegment}
               */
              (s) =>
                Boolean(s) &&
                typeof s === "object" &&
                Array.isArray(s.segment) &&
                s.segment.length >= 2 &&
                typeof s.segment[0] === "number" &&
                typeof s.segment[1] === "number" &&
                Number.isFinite(s.segment[0]) &&
                Number.isFinite(s.segment[1]) &&
                s.segment[0] >= 0 &&
                s.segment[1] > s.segment[0]
            )
            .map(
              /** @param {SponsorBlockSegment} s */
              (s) => ({
                ...s,
                category: typeof s.category === "string" && s.category ? s.category : "sponsor",
                UUID: typeof s.UUID === "string" && s.UUID ? s.UUID : `${s.segment[0]}-${s.segment[1]}`,
              })
            );
          break;
        }
      }

      // Defensive sort: verify start timestamps exist before comparing
      segments.sort((a, b) => {
        const startA = Array.isArray(a?.segment) && typeof a.segment[0] === "number" ? a.segment[0] : 0;
        const startB = Array.isArray(b?.segment) && typeof b.segment[0] === "number" ? b.segment[0] : 0;
        return startA - startB;
      });

      // Cache the validated result
      setInSegmentCache(cacheKey, segments);

      if (segments.length > 0) {
        console.log(`[YT Adjust] Found ${segments.length} SponsorBlock segment(s) for ${videoId}`);
      }

      return segments;
    } catch (err) {
      clearTimeout(timeoutId);
      // Use console.warn instead of console.error so transient network failures
      // do not register runtime error badges on chrome://extensions
      if (err instanceof Error && err.message && err.message.includes("Extension context invalidated")) {
        return [];
      }
      if (err instanceof Error && err.name === "AbortError") {
        console.warn(`[YT Adjust] SponsorBlock request timed out for video ${videoId}`);
      } else {
        console.warn("[YT Adjust] Failed to fetch SponsorBlock segments:", err);
      }
      return [];
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// ---------------------------------------------------------------------------
// Send a message to the MAIN world content script (main.js)
// ---------------------------------------------------------------------------
/**
 * Dispatches an event to the main world content script via window.postMessage.
 *
 * Security and delivery details:
 * Uses window.location.origin as targetOrigin so messages are never dispatched
 * to unintended third-party origins or embedded iframe hosts.
 * Includes source: "yt-adjust-isolated" to let main.js separate extension
 * coordination packets from YouTube's internal postMessage traffic.
 *
 * @param {string} type - Action identifier ("SETTINGS_UPDATE" or "SEGMENTS_UPDATE")
 * @param {Record<string, any>} payload - Structured message content
 * @returns {void}
 */
function sendToMain(type, payload) {
  if (!type || typeof type !== "string") return;

  try {
    window.postMessage(
      {
        source: "yt-adjust-isolated",
        type: type,
        payload: payload || {},
      },
      window.location.origin
    );
  } catch (postError) {
    console.log("[YT Adjust] Failed to post message to main world:", postError);
  }
}

// ---------------------------------------------------------------------------
// Main initialization: load settings and set up for the current video
// ---------------------------------------------------------------------------
/**
 * Orchestrates settings retrieval and segment queries for the active video.
 * Called upon initial script execution and on subsequent client-side navigations.
 *
 * @returns {Promise<void>}
 */
async function initialize() {
  if (!isExtensionContextValid()) return;

  const videoId = getVideoId();

  // Skip duplicate runs if already initialized for this exact video identifier
  if (videoId && videoId === currentVideoId) return;
  currentVideoId = videoId;

  // Load user settings through our guarded fallback helper and transmit to main.js
  // even when landing on a non-watch page so main.js always has current settings
  const settings = await getSettings();
  sendToMain("SETTINGS_UPDATE", settings);

  // Only fetch SponsorBlock segments when on a valid video watch page
  if (!videoId) return;

  // Fetch segments if SponsorBlock is enabled and at least one category is selected
  if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
    const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
    // Guard against cross-video navigation race while network fetch was in flight
    const activeId = getVideoId();
    if (activeId && activeId !== videoId) return;
    sendToMain("SEGMENTS_UPDATE", {
      videoId: videoId,
      segments: segments,
    });
  } else {
    // Transmit empty segments so main.js clears overlays from prior videos
    sendToMain("SEGMENTS_UPDATE", {
      videoId: videoId,
      segments: [],
    });
  }
}

// ---------------------------------------------------------------------------
// YouTube SPA navigation listener
// ---------------------------------------------------------------------------
// YouTube operates as a Single Page Application (SPA).
// When navigating between videos, YouTube modifies the browser URL and swaps
// internal DOM elements without performing a full document page reload.
// Standard DOM events like 'load' or 'DOMContentLoaded' do not fire on transitions.
// YouTube dispatches the custom event 'yt-navigate-finish' on document when a
// client-side page transition completes. Listening to this event is the most
// reliable mechanism to re-initialize extension logic on new videos.
// YouTube dispatches 'yt-navigate-start' as soon as the user clicks a video link,
// before the DOM transition completes. Prefetching SponsorBlock segments here overlaps
// the SHA-256 hash and API lookup with YouTube's page load so 0.0s intro segments are ready.
document.addEventListener("yt-navigate-start", async (e) => {
  if (!isExtensionContextValid()) return;
  try {
    const detail = /** @type {any} */ (e) && /** @type {any} */ (e).detail;
    const upcomingId = detail?.endpoint?.watchEndpoint?.videoId;
    if (typeof upcomingId === "string" && upcomingId.length > 0) {
      const settings = await getSettings();
      if (
        settings.sponsorblockEnabled &&
        Array.isArray(settings.sponsorblockCategories) &&
        settings.sponsorblockCategories.length > 0
      ) {
        fetchSegments(upcomingId, settings.sponsorblockCategories).catch(() => {});
      }
    }
  } catch (_) {}
});

document.addEventListener("yt-navigate-finish", () => {
  if (!isExtensionContextValid()) return;
  // Reset current video ID so initialize() processes the new video cleanly
  currentVideoId = null;
  initialize();
});

// ---------------------------------------------------------------------------
// Initial script load bootstrap
// ---------------------------------------------------------------------------
// Handles direct page visits, hard reloads, and tabs opened in the background.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}

// ---------------------------------------------------------------------------
// Live settings change listener
// ---------------------------------------------------------------------------
// Listens for setting adjustments submitted via popup/popup.js.
// When storage changes, we retrieve current values and relay them to main.js.
if (typeof chrome !== "undefined" && chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (!isExtensionContextValid()) return;
    if (areaName !== "sync" && areaName !== "local") return;

    // Cross-tab pause signal via chrome.storage.local (works even without service worker relay)
    if (changes && changes.ytAdjustActivePlaySignal && changes.ytAdjustActivePlaySignal.newValue) {
      const signal = changes.ytAdjustActivePlaySignal.newValue;
      if (signal && typeof signal === "object" && typeof signal.tabId === "string") {
        sendToMain("PAUSE_FROM_OTHER_TAB", {
          tabId: signal.tabId,
          timestamp: typeof signal.timestamp === "number" ? signal.timestamp : Date.now(),
        });
      }
      const changedKeys = Object.keys(changes);
      if (changedKeys.length === 1 && changedKeys[0] === "ytAdjustActivePlaySignal") {
        return;
      }
    }

    // Load full settings object (bypassing cache) to ensure consistency
    const settings = await getSettings(true);
    sendToMain("SETTINGS_UPDATE", settings);

    // If SponsorBlock settings changed, re-query segments for the active video
    // Note: segmentCache is keyed by `${videoId}:${sortedCategories}`, so previously
    // fetched category combinations are served directly from memory without network I/O.
    const videoId = getVideoId();
    if (videoId && (changes.sponsorblockCategories || changes.sponsorblockEnabled)) {
      if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
        const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
        const activeId = getVideoId();
        if (activeId && activeId !== videoId) return;
        sendToMain("SEGMENTS_UPDATE", {
          videoId: videoId,
          segments: segments,
        });
      } else {
        sendToMain("SEGMENTS_UPDATE", {
          videoId: videoId,
          segments: [],
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-world requests from content/main.js
// ---------------------------------------------------------------------------
// The main world script cannot access chrome.storage. It requests data by
// dispatching a postMessage to window. We validate message origin and payload
// integrity before fulfilling requests.
window.addEventListener("message", async (event) => {
  if (!isExtensionContextValid()) return;
  // Verify sender is the same window context
  if (event.source !== window) return;

  // Origin verification: prevent external websites from triggering extension actions
  if (event.origin !== window.location.origin) return;

  // Payload shape validation
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.source !== "yt-adjust-main") return;

  const { type, payload } = event.data;

  if (type === "REQUEST_SETTINGS") {
    const settings = await getSettings();
    sendToMain("SETTINGS_UPDATE", settings);
  }

  if (type === "PREFETCH_SEGMENTS") {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const videoId = typeof safePayload.videoId === "string" ? safePayload.videoId : "";
    if (videoId) {
      const settings = await getSettings();
      if (
        settings.sponsorblockEnabled &&
        Array.isArray(settings.sponsorblockCategories) &&
        settings.sponsorblockCategories.length > 0
      ) {
        fetchSegments(videoId, settings.sponsorblockCategories).catch(() => {});
      }
    }
  }

  if (type === "REQUEST_SEGMENTS") {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const videoId = typeof safePayload.videoId === "string" ? safePayload.videoId : getVideoId();
    if (videoId) {
      const settings = await getSettings();
      if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
        const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
        const activeId = getVideoId();
        if (activeId && activeId !== videoId) return;
        sendToMain("SEGMENTS_UPDATE", {
          videoId: videoId,
          segments: segments,
        });
      } else {
        sendToMain("SEGMENTS_UPDATE", {
          videoId: videoId,
          segments: [],
        });
      }
    }
  }

  if (type === "TAB_PLAYBACK_STARTED") {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const tabId = typeof safePayload.tabId === "string" ? safePayload.tabId : "";
    const timestamp = typeof safePayload.timestamp === "number" ? safePayload.timestamp : Date.now();
    if (isExtensionContextValid() && typeof chrome !== "undefined") {
      if (chrome?.storage?.local?.set) {
        try {
          const p = chrome.storage.local.set({
            ytAdjustActivePlaySignal: { tabId, timestamp },
          });
          if (p && typeof p.catch === "function") {
            p.catch(() => {});
          }
        } catch (e) {}
      }
      if (chrome.runtime && typeof chrome.runtime.sendMessage === "function") {
        try {
          const res = chrome.runtime.sendMessage({
            type: "PAUSE_OTHER_TABS",
            tabId,
          });
          if (res && typeof res.catch === "function") {
            res.catch(() => {});
          }
        } catch (e) {}
      }
    }
  }
});

// Listen for cross-tab pause commands relayed by the background service worker
if (typeof chrome !== "undefined" && chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!isExtensionContextValid()) return false;
    if (message && typeof message === "object" && message.type === "PAUSE_TAB_VIDEO") {
      sendToMain("PAUSE_FROM_OTHER_TAB", {
        tabId: typeof message.tabId === "string" ? message.tabId : "",
      });
    }
    return false;
  });
}

console.log("[YT Adjust] Isolated world script loaded (v2.4.5)");
