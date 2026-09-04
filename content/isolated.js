// =============================================================================
// YT Adjust — Isolated World Content Script
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
  miniPlayerEnabled: true,
  pipEnabled: true,
  pipAutoOnTabSwitch: true,
};

// SponsorBlock API base URL (public segment query endpoint)
/** @type {string} */
const SB_API_BASE = "https://sponsor.ajay.app/api";

// Cache fetched segments to avoid duplicate API calls when navigating
// Cache fetched segments to avoid duplicate API calls when navigating
// back to a previously watched video in the same session.
// Key format: `${videoId}:${sortedCategories}`
/** @type {Map<string, SponsorBlockSegment[]>} */
const segmentCache = new Map();
const MAX_CACHE_ENTRIES = 50;

/**
 * Safely caches segments while keeping memory consumption bounded.
 *
 * @param {string} key
 * @param {SponsorBlockSegment[]} value
 * @returns {void}
 */
function setInSegmentCache(key, value) {
  if (segmentCache.size >= MAX_CACHE_ENTRIES) {
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

/**
 * Loads stored extension settings with layered fallbacks.
 * Tries chrome.storage.sync first. If sync is unavailable or throws
 * (for example, when browser synchronization is disabled or when the extension
 * context is invalidated during a live extension reload), it falls back to
 * chrome.storage.local. If local storage is also unavailable, it returns DEFAULTS.
 * Suppresses console output on context invalidation to prevent error badges in Chromium.
 *
 * @returns {Promise<ExtensionSettings>} Resolved settings object
 */
async function getSettings() {
  if (!isExtensionContextValid()) {
    return /** @type {ExtensionSettings} */ ({ ...DEFAULTS });
  }

  // Attempt 1: chrome.storage.sync
  try {
    if (typeof chrome !== "undefined" && chrome?.storage?.sync?.get) {
      const syncData = await chrome.storage.sync.get(DEFAULTS);
      if (syncData && typeof syncData === "object") {
        return /** @type {ExtensionSettings} */ ({ ...DEFAULTS, ...syncData });
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
        return /** @type {ExtensionSettings} */ ({ ...DEFAULTS, ...localData });
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
  return /** @type {ExtensionSettings} */ ({ ...DEFAULTS });
}

// ---------------------------------------------------------------------------
// Utility: extract video ID from the current URL
// ---------------------------------------------------------------------------
/**
 * Extracts the 11-character YouTube video ID from the URL search query.
 * Also parses YouTube Shorts paths (/shorts/VIDEO_ID) if present.
 *
 * @returns {string | null} The video identifier or null if not on a video page
 */
function getVideoId() {
  // Check standard watch query parameter ?v=
  const params = new URLSearchParams(window.location.search);
  const queryId = params.get("v");
  if (queryId) return queryId;

  // Check shorts path: /shorts/VIDEO_ID
  const pathname = window.location.pathname;
  if (pathname.startsWith("/shorts/")) {
    const parts = pathname.split("/");
    if (parts[2]) return parts[2];
  }

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
  const cacheKey = `${videoId}:${[...categories].sort().join(",")}`;
  if (segmentCache.has(cacheKey)) {
    return segmentCache.get(cacheKey) || [];
  }

  // Set up an AbortController with a 5-second timeout window
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 5000);

  try {
    const hashPrefix = await sha256Prefix(videoId);

    // Build the API URL with category and action type filters
    const categoriesParam = encodeURIComponent(JSON.stringify(categories));
    const url = `${SB_API_BASE}/skipSegments/${hashPrefix}?categories=${categoriesParam}&actionTypes=${encodeURIComponent('["skip"]')}`;

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

    const data = await response.json();

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
        segments = entry.segments.filter(
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
    // Suppress verbose error logging on deliberate aborts
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`[YT Adjust] SponsorBlock request timed out for video ${videoId}`);
    } else {
      console.error("[YT Adjust] Failed to fetch SponsorBlock segments:", err);
    }
    return [];
  }
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

  // Only execute logic when on a valid video watch or shorts page
  if (!videoId) return;

  // Skip duplicate runs if already initialized for this exact video identifier
  if (videoId === currentVideoId) return;
  currentVideoId = videoId;

  // Load user settings through our guarded fallback helper
  const settings = await getSettings();

  // Transmit settings to main.js so the main world stays synchronized
  sendToMain("SETTINGS_UPDATE", settings);

  // Fetch segments if SponsorBlock is enabled and at least one category is selected
  if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
    const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
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

    // Load full settings object to ensure consistency
    const settings = await getSettings();
    sendToMain("SETTINGS_UPDATE", settings);

    // If SponsorBlock settings changed, re-query segments for the active video
    const videoId = getVideoId();
    if (videoId && (changes.sponsorblockCategories || changes.sponsorblockEnabled)) {
      if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
        // Invalidate stale cache entries for this video ID
        for (const key of segmentCache.keys()) {
          if (key.startsWith(videoId + ":")) {
            segmentCache.delete(key);
          }
        }
        const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
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

  if (type === "REQUEST_SEGMENTS") {
    const safePayload = payload && typeof payload === "object" ? payload : {};
    const videoId = typeof safePayload.videoId === "string" ? safePayload.videoId : getVideoId();
    if (videoId) {
      const settings = await getSettings();
      if (settings.sponsorblockEnabled && Array.isArray(settings.sponsorblockCategories) && settings.sponsorblockCategories.length > 0) {
        const segments = await fetchSegments(videoId, settings.sponsorblockCategories);
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
});

console.log("[YT Adjust] Isolated world script loaded");
