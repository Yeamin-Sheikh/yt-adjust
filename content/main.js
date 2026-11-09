// =============================================================================
// YT Adjust — Main World Content Script (v2.4.3)
// =============================================================================
// Runs in Chrome's MAIN execution world. Has direct access to YouTube's page
// JS objects (such as #movie_player APIs) but CANNOT access chrome.* extension APIs.
//
// Architectural separation and mechanics:
// 1. TrustedHTML and Content Security Policy (CSP):
//    YouTube enforces a strict CSP forbidding string-based innerHTML or insertAdjacentHTML
//    without Trusted Types policies. All UI elements created by YT Adjust (buttons, overlays,
//    toasts, and SVG icons) are constructed programmatically via document.createElement and
//    document.createElementNS, setting textContent and style properties directly.
// 2. Capture-phase event interception:
//    YouTube's player and Polymer framework register bubbling-phase listeners that call
//    e.stopPropagation() on mouse and wheel interactions. To ensure reliable right-click
//    volume adjustment and Shift+scroll speed modification, listeners are attached to
//    document with { capture: true }, intercepting events before YouTube can consume them.
// 3. In-place fixed positioning and layout preservation:
//    When the mini-player activates, ytd-player is positioned fixed in-place without
//    reparenting to document.body, preserving YouTube's internal Polymer component tree.
//    Container minHeight and an in-flow placeholder element preserve layout space to
//    prevent page content jumps when scrolling through comments.
// 4. Web Audio API node lifecycle and caching:
//    The W3C Web Audio API specification mandates that AudioContext.createMediaElementSource()
//    can be invoked only once per HTMLMediaElement. Subsequent calls throw an InvalidStateError.
//    We cache the AudioContext, GainNode, and MediaElementAudioSourceNode on state and reuse them.
// 5. Frame-synchronized segment skipping (requestVideoFrameCallback):
//    Rather than running checks on high-refresh-rate display loops (up to 240Hz via rAF),
//    we synchronize SponsorBlock skipping with requestVideoFrameCallback (~24-60fps), matching
//    decoded video frame presentation times and minimizing CPU consumption.
//
// Receives settings and SponsorBlock data from isolated.js via window.postMessage.
// Seven functional modules:
//   1. Quality forcing via settings menu automation
//   2. SponsorBlock segment skipping + seekbar highlights
//   3. Right-click + scroll volume gesture
//   4. Shift + scroll speed control
//   5. Volume boost (Web Audio API, 150% gain)
//   6. Scroll-to-mini-player (float video when reading comments)
//   7. Picture-in-Picture (Alt+P shortcut, auto-PiP on tab switch)
// =============================================================================

"use strict";

/**
 * @typedef {Object} MainState
 * @property {ExtensionSettings} settings - Current user settings synced from storage
 * @property {SponsorBlockSegment[]} segments - Active SponsorBlock segments for current video
 * @property {string | null} currentVideoId - Current YouTube video identifier
 * @property {Set<string>} skippedSegments - Set of segment UUIDs skipped in current playback session
 * @property {boolean} [_undoSeekInProgress] - True while an Undo toast seek is in flight so seeked does not re-arm the undone segment
 * @property {number | null} skipAnimationFrame - Active rVFC or rAF callback handle
 * @property {HTMLVideoElement | null} [_segmentMonitorVideo] - Video element bound to active segment monitor
 * @property {any} durationPollInterval - Interval handle for seekbar overlay duration polling
 * @property {number} qualityRetryCount - Counter for quality automation retry attempts
 * @property {any} qualityRetryTimer - Timer handle for scheduled quality retry
 * @property {any} [_navInitTimer] - Timer handle for delayed post-navigation control injection
 * @property {number} [_lastNavTime] - Timestamp in ms of the most recent SPA navigation
 * @property {boolean} rightMouseDown - Tracks right mouse button depression
 * @property {boolean} scrolledWhileHeld - True if mouse wheel moved while right mouse button was down
 * @property {any} volumeOverlayTimer - Timer handle for fading out volume overlay
 * @property {any} speedOverlayTimer - Timer handle for fading out speed overlay
 * @property {number} customPlaybackRate - User-configured playback speed multiplier
 * @property {number} [_speedmasterRestoreRate] - Saved custom playback rate while YouTube's Hold-for-2x Speedmaster overlay is active
 * @property {HTMLVideoElement | null} _speedBoundVideo - Active video element with attached rate listeners
 * @property {AudioContext | null} audioContext - Web Audio API context for volume amplification
 * @property {GainNode | null} gainNode - Gain node providing 150% volume boost
 * @property {MediaElementAudioSourceNode | null} mediaSource - Cached media element audio source
 * @property {HTMLVideoElement | null} [_boostBoundVideo] - Video element bound to current MediaElementAudioSourceNode
 * @property {boolean} boostActive - True when 150% audio boost is engaged
 * @property {boolean} miniPlayerActive - True when floating mini-player is in viewport
 * @property {boolean} miniPlayerDismissed - True if user manually closed mini-player for current video
 * @property {HTMLElement | null} [_miniPlayerAnchor] - Container element preserving layout space during mini-player
 * @property {Record<string, string> | null} [_savedVideoStyles] - Preserved inline styles of video element prior to mini-player activation
 * @property {Record<string, string> | null} [_savedContainerStyles] - Preserved inline styles of .html5-video-container prior to mini-player activation
 * @property {Record<string, string> | null} [_savedMoviePlayerStyles] - Preserved inline styles of #movie_player prior to mini-player activation
 * @property {Record<string, string> | null} [_savedLayoutStyles] - Preserved inline minHeight and positioning on layout containers
 * @property {boolean} [_adSkipLogged] - Guard flag preventing console spam during ad playback
 * @property {boolean} pipAutoTriggered - True if Picture-in-Picture was automatically engaged on tab switch
 * @property {boolean} pipManualTriggered - True if Picture-in-Picture was manually engaged via Alt+P
 * @property {boolean} [pipEnteredViaMediaSession] - True when Auto-PiP was initiated by Chromium's MediaSession handler
 * @property {number} [pipEnteredTime] - Timestamp in ms when Picture-in-Picture was engaged
 * @property {number} [pipExitedTime] - Timestamp in ms when Picture-in-Picture was exited or tab returned
 * @property {boolean} [pipNeedsSurfaceRestore] - True when inline video surface needs Blink LayoutVideo restoration after PiP
 * @property {any} [_pipDeferredEnterTimer] - Timer handle for deferred Auto-PiP entry when MediaSession is supported
 * @property {any} [_pipDeferredExitTimer] - Timer handle for deferred auto-PiP exit when returning within 500ms of entry
 * @property {any[]} [_pipCleanupTimers] - Active timer handles for staggered PiP state cleanup passes
 * @property {boolean} [_hasAnnouncedCurrentPlayback] - True when active video playback session has announced itself to other tabs
 * @property {boolean} [_pendingPlayAnnouncement] - True when playback began before initial settings arrived from isolated world
 * @property {number} [_lastPausedByOtherTabTime] - Timestamp in ms when this tab was paused by another tab
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** @type {MainState} */
const state = {
  settings: {
    qualityEnabled: true,
    quality: "hd1080",
    sponsorblockEnabled: true,
    sponsorblockNotify: true,
    sponsorblockCategories: ["sponsor", "selfpromo", "interaction"],
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
  },

  // SponsorBlock
  segments: [],
  currentVideoId: null,
  skippedSegments: new Set(),
  _undoSeekInProgress: false,
  skipAnimationFrame: null,
  _segmentMonitorVideo: null,
  durationPollInterval: null,

  // Quality & navigation timers
  qualityRetryCount: 0,
  qualityRetryTimer: null,
  _navInitTimer: null,
  _lastNavTime: 0,

  // Volume gesture
  rightMouseDown: false,
  scrolledWhileHeld: false,
  volumeOverlayTimer: null,

  // Speed control
  speedOverlayTimer: null,
  customPlaybackRate: 1.0,
  _speedmasterRestoreRate: 0,
  _speedBoundVideo: /** @type {HTMLVideoElement | null} */ (null),

  // Volume boost (Web Audio API)
  audioContext: null,
  gainNode: null,
  mediaSource: null,   // createMediaElementSource() can only be called ONCE per <video>
  _boostBoundVideo: null,
  boostActive: false,

  // Mini-player
  miniPlayerActive: false,
  miniPlayerDismissed: false, // user clicked close — don't re-show until next navigation
  _miniPlayerAnchor: null,
  _savedVideoStyles: null,
  _savedContainerStyles: null,
  _savedMoviePlayerStyles: null,
  _savedLayoutStyles: null,
  _adSkipLogged: false,

  // Picture-in-Picture
  pipAutoTriggered: false,
  pipManualTriggered: false,
  pipEnteredViaMediaSession: false,
  pipEnteredTime: 0,
  pipExitedTime: 0,
  pipNeedsSurfaceRestore: false,
  _pipDeferredEnterTimer: null,
  _pipDeferredExitTimer: null,
  _pipCleanupTimers: [],

  // Cross-tab playback sync
  _hasAnnouncedCurrentPlayback: false,
  _pendingPlayAnnouncement: false,
  _lastPausedByOtherTabTime: 0,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const QUALITY_MAX_RETRIES = 20;
const QUALITY_RETRY_DELAY_MS = 600;
const TOAST_DURATION_MS = 3000;
const VOLUME_OVERLAY_HIDE_MS = 1200;
const SPEED_OVERLAY_HIDE_MS = 1200;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const BOOST_GAIN = 1.5; // 150% volume

// Canonical YouTube player quality codes ordered from highest to lowest resolution
/** @type {string[]} */
const QUALITY_HIERARCHY = [
  "highres",
  "hd2880",
  "hd2160",
  "hd1440",
  "hd1080",
  "hd720",
  "large",
  "medium",
  "small",
  "tiny",
];

// Maps our internal quality keys to the labels YouTube shows in its menu.
// YouTube's quality menu shows labels like "1080p HD", "720p", "480p", etc.
// We match by checking if the menu item label STARTS WITH the resolution text.
/** @type {Record<string, string>} */
const QUALITY_TO_LABEL = {
  highres: "2160p",  // 4K shows as 2160p in the menu
  hd2880: "2880p",
  hd2160: "2160p",
  hd1440: "1440p",
  hd1080: "1080p",
  hd720: "720p",
  large: "480p",
  medium: "360p",
  small: "240p",
  tiny: "144p",
  auto: "Auto",
};

/** @type {Record<string, number>} */
const QUALITY_TO_HEIGHT = {
  highres: 2160,
  hd2880: 2880,
  hd2160: 2160,
  hd1440: 1440,
  hd1080: 1080,
  hd720: 720,
  large: 480,
  medium: 360,
  small: 240,
  tiny: 144,
};

// Numeric heights expected by YouTube's localStorage["yt-player-quality"] schema
/** @type {Record<string, number>} */
const STORAGE_QUALITY_HEIGHT = {
  highres: 4320,
  hd2880: 2880,
  hd2160: 2160,
  hd1440: 1440,
  hd1080: 1080,
  hd720: 720,
  large: 480,
  medium: 360,
  small: 240,
  tiny: 144,
};

// SponsorBlock category display info
/** @type {Record<string, string>} */
const CATEGORY_LABELS = {
  sponsor: "Sponsor",
  selfpromo: "Self-promo",
  interaction: "Interaction",
  intro: "Intro",
  outro: "Outro",
  preview: "Preview",
  filler: "Filler",
  music_offtopic: "Music",
};

/**
 * Resolves the active Web Audio boost gain multiplier from user settings (1.5, 2.0, or 3.0).
 *
 * @returns {number}
 */
function getBoostGain() {
  const level = Number(state.settings.volumeBoostLevel);
  if (level === 1.5 || level === 2 || level === 3) {
    return level;
  }
  return BOOST_GAIN;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
/** @type {HTMLElement | null} */
let _cachedYtdPlayer = null;
/** @type {HTMLVideoElement | null} */
let _cachedVideo = null;

/**
 * Retrieves the YouTube player container element (#movie_player).
 * Cast to YouTubePlayerElement to expose custom methods.
 *
 * @returns {YouTubePlayerElement | null}
 */
function getPlayer() {
  return /** @type {YouTubePlayerElement | null} */ (document.getElementById("movie_player"));
}

/**
 * Returns the ytd-player custom element containing the actual video.
 * YouTube has multiple ytd-player elements (one is a preview/placeholder).
 * We always query for the ancestor of #movie_player and cache the connected element.
 *
 * @returns {HTMLElement | null}
 */
function getYtdPlayer() {
  const moviePlayer = getPlayer();
  if (!moviePlayer) {
    _cachedYtdPlayer = null;
    return null;
  }
  if (
    _cachedYtdPlayer &&
    _cachedYtdPlayer.isConnected !== false &&
    _cachedYtdPlayer.parentElement &&
    moviePlayer.closest("ytd-player") === _cachedYtdPlayer
  ) {
    return _cachedYtdPlayer;
  }
  _cachedYtdPlayer = /** @type {HTMLElement | null} */ (moviePlayer.closest("ytd-player"));
  return _cachedYtdPlayer;
}

/**
 * Retrieves the active HTML5 video element within the YouTube player.
 * Cast to HTMLVideoElement to expose playback properties and frame callbacks.
 * Uses a connected-node cache to avoid repeated querySelector traversals on every frame/scroll.
 *
 * @returns {HTMLVideoElement | null}
 */
function getVideo() {
  const player = getPlayer();
  if (
    _cachedVideo &&
    _cachedVideo.isConnected !== false &&
    _cachedVideo.parentElement &&
    (!player || _cachedVideo.closest("#movie_player") === player)
  ) {
    return _cachedVideo;
  }
  if (!player) {
    _cachedVideo = /** @type {HTMLVideoElement | null} */ (
      document.querySelector("video.html5-main-video") || document.querySelector("video")
    );
    return _cachedVideo;
  }
  _cachedVideo = /** @type {HTMLVideoElement | null} */ (
    player.querySelector("video.html5-main-video") || player.querySelector("video") || document.querySelector("video")
  );
  return _cachedVideo;
}

/**
 * Checks whether the YouTube player is currently playing a pre-roll or mid-roll advertisement.
 * Inspects standard YouTube ad state classes (.ad-showing, .ad-interrupting) on #movie_player.
 *
 * @returns {boolean} True when an advertisement is actively showing or interrupting playback
 */
function isAdPlaying() {
  const player = getPlayer();
  if (!player) return false;
  if (typeof player.className === "string" && player.className.includes("ad-")) {
    const classes = player.className.split(/\s+/);
    if (classes.includes("ad-showing") || classes.includes("ad-interrupting")) {
      return true;
    }
  }
  if (player.classList && typeof player.classList.contains === "function") {
    if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) {
      return true;
    }
  }
  return false;
}

/**
 * Checks whether the active YouTube player is streaming a live broadcast.
 * Used to prevent sticky playback speeds (> 1.0x) from exhausting the live buffer
 * and causing play/stall loops, and to skip static SponsorBlock overlays on live streams.
 *
 * @returns {boolean}
 */
function isLiveStream() {
  const player = getPlayer();
  if (!player) return false;
  if (typeof player.getVideoData === "function") {
    try {
      const data = player.getVideoData();
      if (data && data.isLive) return true;
    } catch (e) {}
  }
  if (typeof player.querySelector === "function") {
    const liveBadge = player.querySelector(".ytp-live");
    if (liveBadge) return true;
  }
  return false;
}

/**
 * Helper: asynchronously pauses execution for a given duration.
 *
 * @param {number} ms - Milliseconds to pause
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// MODULE 1: Auto Quality (Silent Player API + Menu Fallback)
// =============================================================================
// Primary mechanism (Enhancer for YouTube architecture):
// Queries #movie_player.getAvailableQualityLevels() in the MAIN world, resolves
// the highest available tier at or below the user's preferred quality, and calls
// player.setPlaybackQuality(resolved) + player.setPlaybackQualityRange(resolved, resolved)
// alongside writing YouTube's double-stringified numeric height schema to
// localStorage["yt-player-quality"]. This sets quality silently with zero UI menu
// interaction and never triggers the 1080p Premium upsell modal.
//
// Fallback: if a custom player build does not expose getAvailableQualityLevels(),
// falls back to automating clicks through the settings gear menu.
// =============================================================================

let qualityMenuBusy = false;

/**
 * Writes the preferred numeric resolution height to localStorage["yt-player-quality"]
 * and sessionStorage["yt-player-quality"] in the double-stringified JSON schema
 * expected by YouTube's HTML5 player bootstrap.
 *
 * @param {string} qualityCode - Internal YouTube quality code (e.g. "hd1080", "highres")
 * @returns {void}
 */
function persistYouTubeQualityStorage(qualityCode) {
  const height = STORAGE_QUALITY_HEIGHT[qualityCode] || QUALITY_TO_HEIGHT[qualityCode];
  if (!height) return;
  try {
    const now = Date.now();
    const dataPayload = JSON.stringify({ quality: height, previousQuality: height });
    localStorage.setItem(
      "yt-player-quality",
      JSON.stringify({
        data: dataPayload,
        creation: now,
        expiration: now + 31104000000,
      })
    );
    if (typeof sessionStorage !== "undefined" && sessionStorage && typeof sessionStorage.setItem === "function") {
      sessionStorage.setItem(
        "yt-player-quality",
        JSON.stringify({
          data: dataPayload,
          creation: now,
        })
      );
    }
  } catch (_) {}
}

/**
 * Resolves the best available quality code for the current video from
 * `player.getAvailableQualityLevels()` given a user's preferred quality setting.
 *
 * @param {string[]} availableLevels - Array returned by player.getAvailableQualityLevels()
 * @param {string} preferredQuality - User setting (e.g. "highres", "hd1440", "hd1080", "auto")
 * @returns {string} Resolved quality code supported by the current video
 */
function resolveBestAvailableQuality(availableLevels, preferredQuality) {
  if (!Array.isArray(availableLevels) || availableLevels.length === 0) return "";
  if (preferredQuality === "auto") return "auto";
  if (availableLevels.includes(preferredQuality)) return preferredQuality;

  const startIdx = QUALITY_HIERARCHY.indexOf(preferredQuality);
  if (startIdx !== -1) {
    // 1. Walk downward to pick the highest available quality tier <= preferredQuality
    for (let i = startIdx; i < QUALITY_HIERARCHY.length; i++) {
      if (availableLevels.includes(QUALITY_HIERARCHY[i])) {
        return QUALITY_HIERARCHY[i];
      }
    }
    // 2. If all available tiers exceed preferredQuality, walk upward to pick the lowest tier > preferredQuality
    for (let i = startIdx - 1; i >= 0; i--) {
      if (availableLevels.includes(QUALITY_HIERARCHY[i])) {
        return QUALITY_HIERARCHY[i];
      }
    }
  }

  return availableLevels[0];
}

/**
 * Applies the configured preferred video quality level.
 * Uses #movie_player's native getAvailableQualityLevels() + setPlaybackQualityRange()
 * API to switch stream resolution silently without opening the settings gear menu.
 * Defers execution while advertisements are playing so only primary videos are targeted.
 *
 * @returns {Promise<void>}
 */
async function applyQuality() {
  if (!state.settings.qualityEnabled) return;
  if (location.pathname !== "/watch") return;

  const player = getPlayer();
  if (!player) {
    retryQuality();
    return;
  }
  if (isAdPlaying()) {
    // Wait for pre-roll or mid-roll ad to finish without exhausting qualityRetryCount
    if (state.qualityRetryTimer) clearTimeout(state.qualityRetryTimer);
    state.qualityRetryTimer = setTimeout(applyQuality, QUALITY_RETRY_DELAY_MS);
    return;
  }

  const targetQuality = state.settings.quality;
  const targetLabel = QUALITY_TO_LABEL[targetQuality];
  if (!targetLabel) return;

  // Pre-seed localStorage["yt-player-quality"] in YouTube's numeric height schema
  persistYouTubeQualityStorage(targetQuality);

  // 1. Primary path: Direct #movie_player API (silent, instant, zero UI popups)
  if (
    typeof player.getAvailableQualityLevels === "function" &&
    (typeof player.setPlaybackQualityRange === "function" || typeof player.setPlaybackQuality === "function")
  ) {
    try {
      const availableLevels = player.getAvailableQualityLevels();
      if (Array.isArray(availableLevels)) {
        if (availableLevels.length === 0) {
          // Player manifest has not populated quality levels yet; wait and retry without opening menu
          retryQuality();
          return;
        }
        const resolvedQuality = resolveBestAvailableQuality(availableLevels, targetQuality);
        if (resolvedQuality) {
          if (typeof player.setPlaybackQuality === "function") {
            player.setPlaybackQuality(resolvedQuality);
          }
          if (typeof player.setPlaybackQualityRange === "function") {
            player.setPlaybackQualityRange(resolvedQuality, resolvedQuality);
          }
          persistYouTubeQualityStorage(resolvedQuality);
          console.log(`[YT Adjust] Quality set to ${resolvedQuality} via player API`);
          return;
        }
      }
    } catch (apiErr) {
      // Fall through to secondary checks and menu fallback if player API threw
    }
  }

  // 2. Check current quality label if exposed by YouTube player
  if (typeof player.getPlaybackQualityLabel === "function") {
    const currentLabel = player.getPlaybackQualityLabel();
    if (currentLabel && currentLabel.startsWith(targetLabel)) {
      console.log(`[YT Adjust] Quality already at ${currentLabel}`);
      return;
    }
  }

  // 3. Check video element dimensions as a secondary indicator (exact vertical height match)
  const video = getVideo();
  const expectedHeight = QUALITY_TO_HEIGHT[targetQuality];
  if (video && expectedHeight && video.videoHeight === expectedHeight) {
    console.log(`[YT Adjust] Quality already ${targetLabel} (${video.videoWidth}x${video.videoHeight})`);
    return;
  }

  // 4. Fallback: Automate settings menu if player API methods are unavailable
  try {
    await setQualityViaMenu(player, targetLabel);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log("[YT Adjust] Quality menu automation failed:", errorMsg);
    retryQuality();
  } finally {
    dismissPremiumModal();
  }
}

/**
 * Checks whether a quality menu item represents a paid YouTube Premium upsell.
 * YouTube offers duplicate options like "1080p Premium HD" with "Enhanced bitrate".
 * Clicking these without an active YouTube Premium subscription triggers a modal
 * prompting the user to buy or reactivate YouTube Premium.
 *
 * Verifies:
 * 1. Dedicated YouTube premium classes (.ytp-premium-label, .ytp-menuitem-premium, etc.)
 * 2. Sublabels indicating enhanced/bitrate tiers (.ytp-menuitem-sublabel / .ytp-menuitem-content)
 * 3. Element class names containing "premium"
 * 4. Text content or accessibility labels containing "premium", "enhanced", or "bitrate"
 *
 * @param {Element} opt - YouTube settings menu item element (.ytp-menuitem)
 * @returns {boolean} True if the option represents a premium/enhanced bitrate tier
 */
function isPremiumQualityOption(opt) {
  if (typeof opt.querySelector === "function") {
    // Dedicated YouTube premium badge and container classes
    if (opt.querySelector(".ytp-premium-label, [class*='premium'], .ytp-menuitem-premium, .ytp-premium-badge")) {
      return true;
    }
    // Sublabels: YouTube shows "Enhanced bitrate" inside a secondary container
    const sublabel = opt.querySelector(".ytp-menuitem-sublabel, .ytp-menuitem-content");
    if (sublabel && sublabel.textContent && sublabel.textContent.trim().length > 0) {
      const subText = sublabel.textContent.toLowerCase();
      if (subText.includes("enhanced") || subText.includes("bitrate") || subText.includes("premium")) {
        return true;
      }
    }
  }

  // Root class indicator
  if (opt.className && typeof opt.className === "string" && opt.className.toLowerCase().includes("premium")) {
    return true;
  }

  // Text content and aria-label inspection
  const labelEl = typeof opt.querySelector === "function" ? opt.querySelector(".ytp-menuitem-label") : null;
  const labelText = labelEl && labelEl.textContent ? labelEl.textContent : "";
  const directText = opt.textContent || "";
  const ariaLabel = typeof opt.getAttribute === "function" ? (opt.getAttribute("aria-label") || "") : "";

  const fullText = `${directText} ${labelText} ${ariaLabel}`.toLowerCase();
  return fullText.includes("premium") || fullText.includes("enhanced") || fullText.includes("bitrate");
}

/**
 * Finds the best matching non-premium quality option from YouTube's menu.
 * When YouTube offers "1080p Premium HD" alongside standard "1080p HD",
 * this specifically selects the standard, non-duplicate resolution.
 *
 * Even if YouTube's DOM layout changes or omits descriptive text, when duplicate
 * options matching the requested resolution exist (such as 1080p), the script
 * will always pick the standard option (the second match) rather than the first.
 *
 * @param {NodeListOf<Element> | Element[]} qualityOptions - Available menu item elements
 * @param {string} resolutionLabel - Target resolution label (e.g. "1080p")
 * @returns {HTMLElement | null} The target option element to click, or null
 */
function findQualityOption(qualityOptions, resolutionLabel) {
  const matches = [];

  for (const opt of qualityOptions) {
    const label = opt.querySelector(".ytp-menuitem-label");
    if (!label || !label.textContent) continue;
    const text = label.textContent.trim();

    // Match label starting with resolution (e.g. "1080p", "1080p HD", "1080p Premium HD")
    if (text.startsWith(resolutionLabel)) {
      matches.push(/** @type {HTMLElement} */ (opt));
    }
  }

  if (matches.length === 0) return null;

  // Filter out any explicitly flagged premium options
  const standardMatches = matches.filter((opt) => !isPremiumQualityOption(opt));

  if (standardMatches.length > 0) {
    // If multiple non-premium matches exist, pick the last one (safest standard choice)
    return standardMatches[standardMatches.length - 1];
  }

  // Duplicate resolution fallback: YouTube ALWAYS lists the premium upsell at index 0,
  // and the standard free resolution below it. If multiple matches exist, pick the last one.
  if (matches.length > 1) {
    return matches[matches.length - 1];
  }

  // Only one match existed, and it was flagged as premium: DO NOT CLICK IT to avoid paywall modal
  if (isPremiumQualityOption(matches[0])) {
    console.log(`[YT Adjust] Bypassing ${resolutionLabel} because only premium tier is available`);
    return null;
  }

  return matches[0];
}

/**
 * Automatically dismisses YouTube Premium upsell modals ("Reactivate YouTube Premium")
 * by finding and clicking the "Not now" button if the dialog appears.
 * Scopes queries to dialog containers first and verifies that non-trivial dialogs
 * relate to Premium/bitrate upsells so unrelated user modals are never closed.
 *
 * @returns {boolean} True if a dialog was found and dismissed
 */
function dismissPremiumModal() {
  const dialogs = document.querySelectorAll(
    "ytd-popup-container, tp-yt-paper-dialog, ytd-modal-with-title-and-button-renderer, .yt-mealbar-promo-renderer, .ytd-mealbar-promo-renderer"
  );
  for (const dialog of dialogs) {
    const dialogText = (dialog.textContent || "").trim().toLowerCase();
    const buttons = dialog.querySelectorAll("button, yt-button-renderer, tp-yt-paper-button");
    for (const btn of buttons) {
      const text = (btn.textContent || "").trim().toLowerCase();
      if (text === "not now" || text === "no thanks" || text === "dismiss") {
        // Confirm the dialog is a Premium/bitrate upsell (or a minimal synthetic test dialog)
        const isPremiumDialog =
          dialogText === text ||
          dialogText.includes("premium") ||
          dialogText.includes("enhanced") ||
          dialogText.includes("bitrate") ||
          dialogText.includes("trial") ||
          dialogText.includes("membership");
        if (isPremiumDialog) {
          /** @type {HTMLElement} */ (btn).click();
          console.log("[YT Adjust] Automatically dismissed YouTube Premium upsell dialog");
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Clicks through YouTube's settings menu to select a specific quality level.
 * Steps: settings gear → Quality item → target resolution → close menu
 * Guarded by qualityMenuBusy mutex to prevent concurrent callers from toggling the menu closed.
 *
 * @param {YouTubePlayerElement} player - YouTube player DOM element
 * @param {string} targetLabel - Target resolution label (e.g. "1080p")
 * @returns {Promise<void>}
 */
async function setQualityViaMenu(player, targetLabel) {
  if (qualityMenuBusy) {
    retryQuality();
    return;
  }
  const settingsBtn = /** @type {HTMLElement | null} */ (player.querySelector(".ytp-settings-button"));
  if (!settingsBtn) throw new Error("settings button not found");

  qualityMenuBusy = true;
  try {
    // Open settings menu
    settingsBtn.click();
    await sleep(300);

    // Find the "Quality" menu item
    const menuItems = player.querySelectorAll(".ytp-menuitem");
    let qualityItem = null;
    for (const item of menuItems) {
      const label = item.querySelector(".ytp-menuitem-label");
      if (label && label.textContent && label.textContent.trim() === "Quality") {
        qualityItem = /** @type {HTMLElement} */ (item);
        break;
      }
    }

    if (!qualityItem) {
      settingsBtn.click(); // close menu
      throw new Error("Quality menu item not found");
    }

    // Click to open quality submenu
    qualityItem.click();
    await sleep(300);

    // Find the target quality option using duplicate-aware non-premium matcher
    const qualityOptions = player.querySelectorAll(".ytp-menuitem");
    let targetOption = findQualityOption(qualityOptions, targetLabel);

    if (!targetOption && targetLabel !== "Auto") {
      // Target quality not available — find highest available below target
      const qualityOrder = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"];
      const targetIndex = qualityOrder.indexOf(targetLabel);

      if (targetIndex !== -1) {
        for (let i = targetIndex + 1; i < qualityOrder.length; i++) {
          targetOption = findQualityOption(qualityOptions, qualityOrder[i]);
          if (targetOption) break;
        }
      }
    }

    if (targetOption) {
      // Check if already selected
      if (targetOption.getAttribute("aria-checked") !== "true") {
        targetOption.click();
        console.log(`[YT Adjust] Quality set to ${targetLabel} via menu`);
      } else {
        // Already selected, close the menu
        settingsBtn.click();
        console.log(`[YT Adjust] Quality ${targetLabel} already selected`);
      }
    } else {
      settingsBtn.click(); // close menu
      console.log(`[YT Adjust] Target quality ${targetLabel} not found in menu`);
    }

    // Safety net: immediately dismiss any upsell dialog if triggered
    await sleep(350);
    dismissPremiumModal();
  } finally {
    qualityMenuBusy = false;
  }
}

/**
 * Schedules a delayed retry for quality enforcement.
 * Stops retrying after reaching QUALITY_MAX_RETRIES.
 *
 * @returns {void}
 */
function retryQuality() {
  if (state.qualityRetryCount >= QUALITY_MAX_RETRIES) {
    console.log("[YT Adjust] Gave up setting quality after max retries");
    return;
  }
  state.qualityRetryCount++;
  if (state.qualityRetryTimer) {
    clearTimeout(state.qualityRetryTimer);
  }
  state.qualityRetryTimer = setTimeout(applyQuality, QUALITY_RETRY_DELAY_MS);
}

// =============================================================================
// MODULE 2: SponsorBlock Skipping and Seekbar Highlights
// =============================================================================

// --- 2A: Segment skipping ---

/**
 * Initiates continuous monitoring of playback position against SponsorBlock segments.
 * Uses requestVideoFrameCallback when available to evaluate checks per decoded frame.
 *
 * @returns {void}
 */
function startSegmentMonitor() {
  stopSegmentMonitor();
  if (!state.settings.sponsorblockEnabled || state.segments.length === 0 || isLiveStream()) return;

  const video = getVideo();
  if (!video) return;
  state._segmentMonitorVideo = video;

  // Prune skippedSegments when the user manually scrubs backward prior to a segment,
  // and restart the monitor loop if it had previously gone idle after passing all segments.
  if (typeof video.addEventListener === "function" && !video.dataset?.ytAdjustSeekBound) {
    if (video.dataset) video.dataset.ytAdjustSeekBound = "true";
    video.addEventListener("seeked", () => {
      if (state._undoSeekInProgress) {
        state._undoSeekInProgress = false;
        return;
      }
      const currentTime = video.currentTime;
      let hasUpcomingSegment = false;
      for (const segment of state.segments) {
        if (!segment || !Array.isArray(segment.segment) || segment.segment.length < 2) continue;
        const [start, end] = segment.segment;
        const uuid = typeof segment.UUID === "string" && segment.UUID ? segment.UUID : `${start}-${end}`;
        if (currentTime <= Math.max(0, start - 0.5) && state.skippedSegments.has(uuid)) {
          state.skippedSegments.delete(uuid);
        }
        if (!state.skippedSegments.has(uuid) && currentTime < end - 0.1) {
          hasUpcomingSegment = true;
        }
      }
      if (hasUpcomingSegment && state.skipAnimationFrame === null && state.settings.sponsorblockEnabled) {
        startSegmentMonitor();
      }
    });
  }

  // Resume segment monitoring when playback resumes if the rAF fallback paused while video was paused
  if (typeof video.addEventListener === "function" && !video.dataset?.ytAdjustPlayMonitorBound) {
    if (video.dataset) video.dataset.ytAdjustPlayMonitorBound = "true";
    video.addEventListener("play", () => {
      if (state.skipAnimationFrame === null && state.settings.sponsorblockEnabled && state.segments.length > 0) {
        startSegmentMonitor();
      }
    });
  }

  function checkSegments() {
    if (!video || !video.isConnected) {
      state.skipAnimationFrame = null;
      return;
    }

    if (!video.paused && !video.seeking && !isAdPlaying()) {
      let currentTime = video.currentTime;

      for (const segment of state.segments) {
        if (!segment || !Array.isArray(segment.segment) || segment.segment.length < 2) {
          continue;
        }

        const [start, end] = segment.segment;
        if (
          typeof start !== "number" ||
          typeof end !== "number" ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start
        ) {
          continue;
        }

        const uuid = typeof segment.UUID === "string" && segment.UUID ? segment.UUID : `${start}-${end}`;

        if (state.skippedSegments.has(uuid)) continue;

        if (currentTime >= start && currentTime < end - 0.1) {
          let finalEnd = end;
          state.skippedSegments.add(uuid);

          // Chain overlapping or contiguous segments into a single seek (SponsorBlock technique)
          let chained = true;
          while (chained) {
            chained = false;
            for (const nextSeg of state.segments) {
              if (!nextSeg || !Array.isArray(nextSeg.segment) || nextSeg.segment.length < 2) continue;
              const [nStart, nEnd] = nextSeg.segment;
              if (
                typeof nStart !== "number" ||
                typeof nEnd !== "number" ||
                !Number.isFinite(nStart) ||
                !Number.isFinite(nEnd) ||
                nEnd <= nStart
              ) {
                continue;
              }
              const nUuid = typeof nextSeg.UUID === "string" && nextSeg.UUID ? nextSeg.UUID : `${nStart}-${nEnd}`;
              if (state.skippedSegments.has(nUuid)) continue;
              if (nStart <= finalEnd + 0.05 && nEnd > finalEnd) {
                finalEnd = nEnd;
                state.skippedSegments.add(nUuid);
                chained = true;
              }
            }
          }

          // Clamp end-of-video skips so playlist auto-advance and video looping never stall
          let seekTarget = finalEnd;
          if (typeof video.duration === "number" && Number.isFinite(video.duration) && video.duration > 0) {
            if (seekTarget >= video.duration) {
              seekTarget = video.loop ? 0 : Math.max(0, video.duration - 0.01);
            }
          }

          video.currentTime = seekTarget;
          currentTime = finalEnd;

          const catLabel = CATEGORY_LABELS[segment.category] || segment.category;
          const dur = Math.round(finalEnd - start);
          console.log(`[YT Adjust] Skipped ${catLabel} (${dur}s): ${start.toFixed(1)}s → ${finalEnd.toFixed(1)}s`);

          if (state.settings.sponsorblockNotify) {
            showSkipToast(`${catLabel} skipped (${dur}s)`, start);
          }
          break;
        }
      }

      // Check if any unskipped segments still lie ahead of the current playhead.
      // Once all segments have been skipped or passed, halt the 60fps loop to save CPU/battery;
      // the 'seeked' listener will automatically restart it if the user rewinds.
      let anyRemaining = false;
      for (const segment of state.segments) {
        if (!segment || !Array.isArray(segment.segment) || segment.segment.length < 2) continue;
        const [start, end] = segment.segment;
        const uuid = typeof segment.UUID === "string" && segment.UUID ? segment.UUID : `${start}-${end}`;
        if (!state.skippedSegments.has(uuid) && currentTime < end - 0.1) {
          anyRemaining = true;
          break;
        }
      }
      if (!anyRemaining) {
        state.skipAnimationFrame = null;
        return;
      }
    }

    // requestVideoFrameCallback synchronizes checks to decoded video frames
    if (typeof video.requestVideoFrameCallback === "function") {
      state.skipAnimationFrame = video.requestVideoFrameCallback(checkSegments);
    } else if (!video.paused) {
      state.skipAnimationFrame = requestAnimationFrame(checkSegments);
    } else {
      state.skipAnimationFrame = null;
    }
  }

  // Start the check loop
  if (typeof video.requestVideoFrameCallback === "function") {
    state.skipAnimationFrame = video.requestVideoFrameCallback(checkSegments);
  } else {
    state.skipAnimationFrame = requestAnimationFrame(checkSegments);
  }
}

/**
 * Halts the active SponsorBlock segment monitor loop.
 * Cancels either the rVFC or rAF callback based on whichever was registered.
 *
 * @returns {void}
 */
function stopSegmentMonitor() {
  if (state.skipAnimationFrame !== null) {
    const video = state._segmentMonitorVideo || getVideo();
    if (video && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(state.skipAnimationFrame);
    } else {
      cancelAnimationFrame(state.skipAnimationFrame);
    }
    state.skipAnimationFrame = null;
  }
  state._segmentMonitorVideo = null;
}

// --- 2B: Seekbar overlay ---
// Renders white marker bars on YouTube's progress bar showing where skippable segments are.
// Bars are centered vertically on the seekbar and overflow slightly above and below for visibility.

/**
 * Builds and mounts the seekbar highlight overlay inside YouTube's progress bar.
 * Anchors markers inside .ytp-chapters-container for 1:1 timeline alignment.
 *
 * @returns {void}
 */
function renderSeekbarOverlay() {
  // Remove existing overlay
  const existing = document.getElementById("yt-adjust-seekbar-overlay");
  if (existing) existing.remove();

  if (!state.settings.sponsorblockEnabled || !Array.isArray(state.segments) || state.segments.length === 0) return;
  if (isAdPlaying() || isLiveStream()) return;

  const video = getVideo();
  if (!video || !video.duration || isNaN(video.duration) || !Number.isFinite(video.duration)) return;

  const validSegments = state.segments.filter(
    (s) =>
      Boolean(s) &&
      Array.isArray(s.segment) &&
      s.segment.length >= 2 &&
      typeof s.segment[0] === "number" &&
      typeof s.segment[1] === "number" &&
      Number.isFinite(s.segment[0]) &&
      Number.isFinite(s.segment[1]) &&
      s.segment[0] >= 0 &&
      s.segment[1] > s.segment[0]
  );

  if (validSegments.length === 0) return;

  // Validate: if any segment end extends beyond duration, an ad is likely playing
  const maxSegEnd = Math.max(...validSegments.map((s) => s.segment[1]));
  if (maxSegEnd > video.duration + 5) {
    if (!state._adSkipLogged) {
      console.log(`[YT Adjust] Waiting for real video, ad detected (${video.duration.toFixed(0)}s)`);
      state._adSkipLogged = true;
    }
    return;
  }

  // Anchor to chapters container matching visible progress bar width
  const chaptersContainer = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-chapters-container"));
  if (!chaptersContainer) return;

  const overlay = document.createElement("div");
  overlay.id = "yt-adjust-seekbar-overlay";
  Object.assign(overlay.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "35",       // above progress fill, below scrubber
    overflow: "visible", // allow bars to extend above/below
  });

  const duration = video.duration;

  for (const segment of validSegments) {
    const [start, end] = segment.segment;
    const leftPercent = Math.max(0, Math.min(100, (start / duration) * 100));
    const widthPercent = Math.max(0, Math.min(100 - leftPercent, ((end - start) / duration) * 100));
    const catLabel = CATEGORY_LABELS[segment.category] || segment.category;

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      left: `${leftPercent}%`,
      width: `${widthPercent}%`,
      minWidth: "2px",
      top: "-25%",
      height: "150%",
      backgroundColor: "#fff",
      opacity: "0.35",
      transform: "scaleY(1)",
      willChange: "transform, opacity",
      pointerEvents: "none",
      borderRadius: "1px",
      transition: "transform 0.15s ease, top 0.15s ease, height 0.15s ease, opacity 0.15s ease",
    });

    bar.dataset.category = segment.category;
    bar.title = `${catLabel} (${Math.round(end - start)}s)`;
    overlay.appendChild(bar);
  }

  chaptersContainer.style.overflow = "visible";
  chaptersContainer.appendChild(overlay);

  // Hover highlighting: expand marker bars on progress bar container hover
  const progressBarContainer = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-progress-bar-container"));
  if (progressBarContainer && !progressBarContainer.dataset.ytAdjustHoverAttached) {
    progressBarContainer.dataset.ytAdjustHoverAttached = "true";

    progressBarContainer.addEventListener("mouseenter", () => {
      const bars = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#yt-adjust-seekbar-overlay > div"));
      bars.forEach((b) => {
        b.style.transform = "scaleY(1.33)";
        b.style.opacity = "0.85";
      });
    });

    progressBarContainer.addEventListener("mouseleave", () => {
      const bars = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#yt-adjust-seekbar-overlay > div"));
      bars.forEach((b) => {
        b.style.transform = "scaleY(1)";
        b.style.opacity = "0.35";
      });
    });
  }

  state._adSkipLogged = false;
  console.log(`[YT Adjust] Rendered ${state.segments.length} seekbar overlay segment(s)`);
}

/**
 * Monitors video duration to detect transitions from advertisements to primary video content.
 * Re-renders seekbar overlays when duration updates to match the actual video length.
 *
 * @returns {void}
 */
function watchForDuration() {
  const video = getVideo();
  if (!video) return;

  if (video.duration && !isNaN(video.duration)) {
    renderSeekbarOverlay();
  }

  // Listen for duration changes on ad-to-video transitions (guarded against duplicate attachment)
  if (typeof video.addEventListener === "function" && !video.dataset.ytAdjustDurationBound) {
    video.dataset.ytAdjustDurationBound = "true";
    video.addEventListener("durationchange", () => {
      renderSeekbarOverlay();
    });
  }

  // Clear any existing polling interval to prevent duplicate timers
  if (state.durationPollInterval) {
    clearInterval(state.durationPollInterval);
    state.durationPollInterval = null;
  }

  // Polling fallback during video bootstrap
  let pollCount = 0;
  state.durationPollInterval = setInterval(() => {
    pollCount++;
    const overlay = document.getElementById("yt-adjust-seekbar-overlay");
    if (overlay && overlay.children.length > 0) {
      if (state.durationPollInterval) {
        clearInterval(state.durationPollInterval);
        state.durationPollInterval = null;
      }
      return;
    }
    renderSeekbarOverlay();
    if (pollCount >= 30) {
      if (state.durationPollInterval) {
        clearInterval(state.durationPollInterval);
        state.durationPollInterval = null;
      }
    }
  }, 1000);
}

// --- 2C: Skip notification with undo button ---

/** @type {((e: KeyboardEvent) => void) | null} */
let undoKeyHandler = null;
/** @type {any} */
let toastDismissTimer = null;

/**
 * Dismisses any active skip notification toast and tears down the undo keyboard listener.
 *
 * @param {boolean} [immediate=false] - When true, immediately unmounts DOM nodes without fade animation
 * @returns {void}
 */
function dismissSkipToast(immediate = false) {
  if (undoKeyHandler) {
    document.removeEventListener("keydown", undoKeyHandler, true);
    undoKeyHandler = null;
  }
  if (toastDismissTimer) {
    clearTimeout(toastDismissTimer);
    toastDismissTimer = null;
  }

  // Query all toast instances to clean up any stray or duplicate elements
  const toasts = /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll("#yt-adjust-toast, .yt-adjust-toast")
  );
  if (toasts.length === 0) return;

  toasts.forEach((toast) => {
    // Immediately remove identity attributes so concurrent calls never match this element
    toast.removeAttribute("id");
    toast.removeAttribute("class");
    toast.className = "";
    if (toast.classList && typeof toast.classList.remove === "function") {
      toast.classList.remove("yt-adjust-toast");
    }
    toast.style.pointerEvents = "none";

    if (immediate) {
      toast.remove();
    } else {
      toast.style.opacity = "0";
      setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 200);
    }
  });
}

/**
 * Displays a toast notification informing the user that a segment was skipped.
 * Provides an "Undo (Enter)" button and Enter key shortcut to jump back to the segment start.
 *
 * @param {string} message - Toast message text
 * @param {number} [undoTimestamp] - Timestamp in seconds to seek back to upon undo
 * @returns {void}
 */
function showSkipToast(message, undoTimestamp) {
  // Synchronously wipe any existing toast instances to eliminate overlapping or orphaned elements
  dismissSkipToast(true);

  const toast = document.createElement("div");
  toast.id = "yt-adjust-toast";
  toast.className = "yt-adjust-toast";

  Object.assign(toast.style, {
    position: "absolute",
    bottom: "60px",
    right: "12px",
    background: "rgba(0, 0, 0, 0.75)",
    color: "#fff",
    padding: "6px 12px",
    borderRadius: "4px",
    fontSize: "13px",
    fontFamily: "'Roboto', 'Arial', sans-serif",
    fontWeight: "500",
    zIndex: "9999",
    opacity: "0",
    transition: "opacity 0.2s ease",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  });

  const text = document.createElement("span");
  text.textContent = message;
  text.style.pointerEvents = "none";
  toast.appendChild(text);

  if (undoTimestamp !== undefined) {
    const undoBtn = document.createElement("button");
    undoBtn.textContent = "Undo (Enter)";
    Object.assign(undoBtn.style, {
      background: "rgba(255, 255, 255, 0.15)",
      color: "#fff",
      border: "1px solid rgba(255, 255, 255, 0.3)",
      borderRadius: "3px",
      padding: "2px 8px",
      fontSize: "12px",
      fontFamily: "inherit",
      cursor: "pointer",
      pointerEvents: "auto",
      transition: "background 0.15s ease",
    });

    undoBtn.addEventListener("mouseenter", () => {
      undoBtn.style.background = "rgba(255, 255, 255, 0.3)";
    });
    undoBtn.addEventListener("mouseleave", () => {
      undoBtn.style.background = "rgba(255, 255, 255, 0.15)";
    });

    undoBtn.addEventListener("click", () => {
      const video = getVideo();
      if (video) {
        state._undoSeekInProgress = true;
        video.currentTime = undoTimestamp;
        console.log(`[YT Adjust] Undo skip — seeking to ${undoTimestamp.toFixed(1)}s`);
      }
      dismissSkipToast(true);
    });

    toast.appendChild(undoBtn);

    // Enter key undo listener with form field exclusion
    undoKeyHandler = (e) => {
      if (e.key !== "Enter" && e.code !== "Enter") return;

      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || /** @type {HTMLElement} */ (active).isContentEditable)) {
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();

      const video = getVideo();
      if (video) {
        state._undoSeekInProgress = true;
        video.currentTime = undoTimestamp;
        console.log(`[YT Adjust] Undo skip via Enter key — seeking to ${undoTimestamp.toFixed(1)}s`);
      }
      dismissSkipToast(true);
    };

    document.addEventListener("keydown", undoKeyHandler, true);
  }

  // Pause auto-dismiss when hovering over the toast so the user can comfortably click Undo
  toast.addEventListener("mouseenter", () => {
    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
      toastDismissTimer = null;
    }
  });

  toast.addEventListener("mouseleave", () => {
    if (toastDismissTimer) {
      clearTimeout(toastDismissTimer);
    }
    toastDismissTimer = setTimeout(() => {
      dismissSkipToast(false);
    }, 1500);
  });

  const player = getPlayer();
  if (player) {
    player.appendChild(toast);
  } else {
    document.body.appendChild(toast);
  }

  requestAnimationFrame(() => {
    toast.style.opacity = "0.6";
  });
  toastDismissTimer = setTimeout(() => {
    dismissSkipToast(false);
  }, TOAST_DURATION_MS);
}

// =============================================================================
// MODULE 3: Volume Gesture (Right-click + Scroll)
// =============================================================================
// Intercepts right-click + wheel scroll to adjust volume in configurable steps.
// Uses capture: true listeners on document to execute before YouTube's handlers.
// =============================================================================

let volumeGestureInitialized = false;

/**
 * Initializes document-level capture listeners for volume gestures and speed wheel controls.
 *
 * @returns {void}
 */
function setupVolumeGesture() {
  if (volumeGestureInitialized) return;
  volumeGestureInitialized = true;

  /**
   * Evaluates whether an event target is located within the YouTube player hierarchy.
   *
   * @param {EventTarget | null} el - Target node from DOM event
   * @returns {boolean}
   */
  function isInsidePlayer(el) {
    const player = getPlayer();
    if (!player || !el || !(el instanceof Node)) return false;
    return player.contains(el);
  }

  // Mousedown tracking (capture phase)
  document.addEventListener("mousedown", (e) => {
    if (!state.settings.volumeGestureEnabled) return;
    if (e.button !== 2) return; // right button only
    if (!isInsidePlayer(e.target)) return;

    state.rightMouseDown = true;
    state.scrolledWhileHeld = false;
  }, true);

  // Mouseup tracking (capture phase)
  document.addEventListener("mouseup", (e) => {
    if (e.button === 2) {
      state.rightMouseDown = false;
    }
  }, true);

  // Clear rightMouseDown if the window loses focus while right button was held
  window.addEventListener("blur", () => {
    state.rightMouseDown = false;
  });

  // Wheel handler: handles Shift + scroll (speed) and right-click + scroll (volume)
  document.addEventListener("wheel", (e) => {
    const targetElement = e.target instanceof Element ? e.target : null;
    const isOverSpeedBtn =
      state.settings.speedControlEnabled &&
      targetElement !== null &&
      (targetElement.id === "yt-adjust-speed-btn" ||
        targetElement.parentElement?.id === "yt-adjust-speed-btn" ||
        (typeof targetElement.closest === "function" && Boolean(targetElement.closest("#yt-adjust-speed-btn"))));

    // Fast O(1) exit on normal page scroll when neither gesture nor speed pill hover is active
    if (!state.rightMouseDown && !e.shiftKey && !isOverSpeedBtn) return;
    if (!isInsidePlayer(e.target)) return;

    // Speed control: Shift + scroll over player OR wheel directly over speed button
    if (state.settings.speedControlEnabled && (e.shiftKey || isOverSpeedBtn)) {
      const playerForMenuCheck = getPlayer();
      if (
        !isOverSpeedBtn &&
        playerForMenuCheck &&
        playerForMenuCheck.classList &&
        typeof playerForMenuCheck.classList.contains === "function" &&
        (playerForMenuCheck.classList.contains("ytp-settings-shown") ||
          playerForMenuCheck.classList.contains("ytp-menu-shown"))
      ) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();

      const video = getVideo();
      if (!video) return;

      const step = state.settings.speedStep;
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const direction = delta > 0 ? -1 : 1;
      const current = video.playbackRate;
      const newSpeed = Math.max(SPEED_MIN, Math.min(SPEED_MAX,
        Math.round((current + direction * step) / step) * step
      ));
      state.customPlaybackRate = newSpeed;
      state._speedmasterRestoreRate = 0;
      bindSpeedVideo(video);
      video.playbackRate = newSpeed;
      video.defaultPlaybackRate = newSpeed;

      showSpeedOverlay(newSpeed);
      updateSpeedButton(newSpeed);
      return;
    }

    // Volume control: Right-click held + wheel scroll
    if (!state.settings.volumeGestureEnabled) return;
    if (typeof e.buttons === "number" && (e.buttons & 2) === 0) {
      state.rightMouseDown = false;
      return;
    }
    if (!state.rightMouseDown) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    state.scrolledWhileHeld = true;

    const player = getPlayer();
    const video = getVideo();
    if (!player || !video) return;

    const step = state.settings.volumeStep;
    const direction = e.deltaY > 0 ? -1 : 1;

    let currentVolume = 100;
    if (typeof player.getVolume === "function") {
      currentVolume = player.getVolume();
    } else {
      currentVolume = Math.round(video.volume * 100);
    }

    const newVolume = Math.max(0, Math.min(100, currentVolume + direction * step));

    // Update YouTube player volume so native controls reflect the change
    if (typeof player.setVolume === "function") {
      player.setVolume(newVolume);
    } else {
      video.volume = newVolume / 100;
    }

    // Auto-unmute when scrolling up from a muted state
    if (direction > 0) {
      if (typeof player.isMuted === "function" && player.isMuted()) {
        if (typeof player.unMute === "function") player.unMute();
      } else if (video.muted) {
        video.muted = false;
      }
    }

    // Persist updated volume to YouTube's storage keys so YouTube retains it across reloads
    try {
      const now = Date.now();
      const isCurrentlyMuted =
        typeof player.isMuted === "function" ? Boolean(player.isMuted()) : Boolean(video.muted);
      const volPayload = JSON.stringify({
        volume: Math.round(newVolume),
        muted: isCurrentlyMuted,
      });
      if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
        localStorage.setItem(
          "yt-player-volume",
          JSON.stringify({
            data: volPayload,
            creation: now,
            expiration: now + 2592000000,
          })
        );
      }
      if (typeof sessionStorage !== "undefined" && typeof sessionStorage.setItem === "function") {
        sessionStorage.setItem(
          "yt-player-volume",
          JSON.stringify({
            data: volPayload,
            creation: now,
          })
        );
      }
    } catch (_) {}

    showVolumeOverlay(Math.round(newVolume));
  }, { capture: true, passive: false });

  // Context menu suppression: blocks menu only if wheel was scrolled while holding right-click
  document.addEventListener("contextmenu", (e) => {
    if (!state.settings.volumeGestureEnabled) return;
    if (!isInsidePlayer(e.target)) return;
    if (state.scrolledWhileHeld) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.scrolledWhileHeld = false;
    }
  }, true);

  console.log("[YT Adjust] Volume gesture initialized (document-level capture)");
}

/**
 * Displays an on-screen HUD overlay showing the current volume level percentage.
 * Automatically fades out after VOLUME_OVERLAY_HIDE_MS.
 *
 * @param {number} percent - Volume percentage (0-100 or boosted)
 * @returns {void}
 */
function showVolumeOverlay(percent) {
  let overlay = document.getElementById("yt-adjust-volume-overlay");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "yt-adjust-volume-overlay";

    Object.assign(overlay.style, {
      position: "absolute",
      top: "45%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      color: "#fff",
      fontSize: "28px",
      fontFamily: "'Roboto', 'Arial', sans-serif",
      fontWeight: "600",
      letterSpacing: "1px",
      zIndex: "99999",
      pointerEvents: "none",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "6px",
      opacity: "0",
      transition: "opacity 0.15s ease",
      textShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
    });

    const label = document.createElement("span");
    label.id = "yt-adjust-volume-label";
    overlay.appendChild(label);

    const barContainer = document.createElement("div");
    Object.assign(barContainer.style, {
      width: "80px",
      height: "3px",
      background: "rgba(255, 255, 255, 0.2)",
      borderRadius: "2px",
      overflow: "hidden",
    });

    const barFill = document.createElement("div");
    barFill.id = "yt-adjust-volume-bar";
    Object.assign(barFill.style, {
      height: "100%",
      background: "#fff",
      borderRadius: "2px",
      transition: "width 0.1s ease",
    });
    barContainer.appendChild(barFill);
    overlay.appendChild(barContainer);

    const player = getPlayer();
    if (player) {
      player.appendChild(overlay);
    }
  }

  const label = document.getElementById("yt-adjust-volume-label");
  const bar = document.getElementById("yt-adjust-volume-bar");

  if (label) label.textContent = `${percent}%`;
  if (bar) bar.style.width = `${Math.min(100, percent)}%`;

  overlay.style.opacity = "0.65";

  if (state.volumeOverlayTimer) {
    clearTimeout(state.volumeOverlayTimer);
  }
  state.volumeOverlayTimer = setTimeout(() => {
    if (overlay) overlay.style.opacity = "0";
  }, VOLUME_OVERLAY_HIDE_MS);
}

// =============================================================================
// MODULE 4: Speed Control (Shift + Scroll)
// =============================================================================

/**
 * Displays an on-screen HUD overlay showing the updated playback speed.
 *
 * @param {number} speed - Playback speed multiplier (e.g. 1.25)
 * @returns {void}
 */
function showSpeedOverlay(speed) {
  let overlay = document.getElementById("yt-adjust-speed-overlay");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "yt-adjust-speed-overlay";

    Object.assign(overlay.style, {
      position: "absolute",
      top: "45%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      color: "#fff",
      fontSize: "28px",
      fontFamily: "'Roboto', 'Arial', sans-serif",
      fontWeight: "600",
      letterSpacing: "1px",
      zIndex: "99999",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.15s ease",
      textShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
    });

    const label = document.createElement("span");
    label.id = "yt-adjust-speed-label";
    overlay.appendChild(label);

    const player = getPlayer();
    if (player) player.appendChild(overlay);
  }

  const label = document.getElementById("yt-adjust-speed-label");
  if (label) label.textContent = `${speed.toFixed(2).replace(/\.?0+$/, "")}x`;

  overlay.style.opacity = "0.65";

  if (state.speedOverlayTimer) {
    clearTimeout(state.speedOverlayTimer);
  }
  state.speedOverlayTimer = setTimeout(() => {
    if (overlay) overlay.style.opacity = "0";
  }, SPEED_OVERLAY_HIDE_MS);
}

/**
 * Checks whether YouTube's native "Hold for 2x" Speedmaster overlay is currently visible.
 * When active, YouTube temporarily boosts playbackRate to 2.0x while the user holds down
 * left-click or Spacebar and resets it to 1.0x on release.
 *
 * @returns {boolean}
 */
function isSpeedmasterOverlayActive() {
  const player = getPlayer();
  const root = player || document;
  if (!root || typeof root.querySelector !== "function") return false;
  const overlay = /** @type {HTMLElement | null} */ (root.querySelector(".ytp-speedmaster-overlay"));
  if (!overlay) return false;
  return (
    overlay.clientWidth > 0 ||
    overlay.offsetWidth > 0 ||
    overlay.style?.display === "block"
  );
}

/**
 * Attaches playbackRate event listeners to the active video element.
 * Ensures the speed button stays in sync with native YouTube menu changes,
 * preserves custom speed across YouTube's "Hold for 2x" Speedmaster gesture,
 * and persists custom playback speed across video transitions.
 *
 * @param {HTMLVideoElement | null} video - The active video element
 * @returns {void}
 */
function bindSpeedVideo(video) {
  if (!video) return;
  if (state._speedBoundVideo === video) return;
  state._speedBoundVideo = video;

  // Apply custom speed if one was configured, not default 1x, and not on a live stream or ad
  if (
    !isLiveStream() &&
    !isAdPlaying() &&
    state.customPlaybackRate &&
    Math.abs(state.customPlaybackRate - 1.0) >= 0.01
  ) {
    video.playbackRate = state.customPlaybackRate;
    video.defaultPlaybackRate = state.customPlaybackRate;
    updateSpeedButton(state.customPlaybackRate);
  } else {
    updateSpeedButton(video.playbackRate || 1.0);
  }

  // Handle video metadata loading (YouTube resets rate when loading new media stream)
  video.addEventListener("loadedmetadata", () => {
    if (isAdPlaying() || isLiveStream()) {
      updateSpeedButton(video.playbackRate || 1.0);
      return;
    }
    if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
      video.playbackRate = state.customPlaybackRate;
      video.defaultPlaybackRate = state.customPlaybackRate;
      updateSpeedButton(state.customPlaybackRate);
    } else {
      updateSpeedButton(video.playbackRate || 1.0);
    }
  });

  // Handle play start
  video.addEventListener("play", () => {
    if (isAdPlaying() || isLiveStream()) return;
    if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
      if (Math.abs(video.playbackRate - state.customPlaybackRate) >= 0.01) {
        video.playbackRate = state.customPlaybackRate;
        video.defaultPlaybackRate = state.customPlaybackRate;
      }
      updateSpeedButton(state.customPlaybackRate);
    }
  });

  // Bi-directional sync: if rate changes (e.g. from YouTube's native settings menu or Hold-for-2x Speedmaster)
  video.addEventListener("ratechange", () => {
    if (isAdPlaying()) return;
    const currentRate = video.playbackRate;

    // 1. Detect YouTube's native "Hold for 2x" Speedmaster gesture:
    // Preserve customPlaybackRate while Speedmaster is held and restore it upon release.
    if (Math.abs(currentRate - 2.0) < 0.01 && isSpeedmasterOverlayActive()) {
      if (!state._speedmasterRestoreRate) {
        state._speedmasterRestoreRate = state.customPlaybackRate || 1.0;
      }
      updateSpeedButton(2.0);
      return;
    }
    if (state._speedmasterRestoreRate && Math.abs(currentRate - 2.0) >= 0.01) {
      const restoreRate = state._speedmasterRestoreRate;
      state._speedmasterRestoreRate = 0;
      state.customPlaybackRate = restoreRate;
      if (!isLiveStream() && Math.abs(currentRate - restoreRate) >= 0.01) {
        video.playbackRate = restoreRate;
        video.defaultPlaybackRate = restoreRate;
      }
      updateSpeedButton(restoreRate);
      return;
    }

    if (state.customPlaybackRate && Math.abs(currentRate - state.customPlaybackRate) < 0.01) {
      updateSpeedButton(currentRate);
      return;
    }
    // Ignore transient 1.0x stream resets emitted before metadata loads or during SPA navigation
    const isTransientReset =
      (typeof video.readyState === "number" && video.readyState <= 1) ||
      (typeof video.currentTime === "number" &&
        video.currentTime < 1.5 &&
        Boolean(state._lastNavTime) &&
        Date.now() - (state._lastNavTime || 0) < 4000);
    if (
      Math.abs(currentRate - 1.0) < 0.01 &&
      state.customPlaybackRate &&
      Math.abs(state.customPlaybackRate - 1.0) >= 0.01 &&
      isTransientReset
    ) {
      if (!isLiveStream() && typeof video.readyState === "number" && video.readyState >= 1) {
        video.playbackRate = state.customPlaybackRate;
        video.defaultPlaybackRate = state.customPlaybackRate;
        updateSpeedButton(state.customPlaybackRate);
      }
      return;
    }
    // Rate changed externally (e.g. user selected another speed from YouTube's gear menu)
    state.customPlaybackRate = currentRate;
    video.defaultPlaybackRate = currentRate;
    updateSpeedButton(currentRate);
  });
}

/**
 * Injects a speed indicator and reset button into YouTube's player control bar.
 * Clicking resets speed to 1.0x. Scrolling over the button adjusts speed.
 *
 * @returns {void}
 */
function injectSpeedButton() {
  if (document.getElementById("yt-adjust-speed-btn")) {
    const video = getVideo();
    bindSpeedVideo(video);
    const currentSpeed = (video && video.playbackRate) ? video.playbackRate : (state.customPlaybackRate || 1);
    updateSpeedButton(currentSpeed);
    return;
  }

  const rightControlsLeft = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-right-controls-left"));
  const settingsBtn = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-settings-button"));
  if (!rightControlsLeft || !settingsBtn) return;

  // Insert style element for YouTube pill sizing
  if (!document.getElementById("yt-adjust-speed-style")) {
    const style = document.createElement("style");
    style.id = "yt-adjust-speed-style";
    style.textContent = `
      #yt-adjust-speed-btn::before {
        width: calc(100% + 4px) !important;
        height: calc(var(--yt-delhi-pill-height, 48px) - 8px) !important;
        left: 50% !important;
        top: 50% !important;
        transform: translate(-50%, -50%) !important;
        border-radius: 20px !important;
      }
    `;
    const styleTarget = document.head || document.documentElement || document.body;
    if (styleTarget && typeof styleTarget.appendChild === "function") {
      styleTarget.appendChild(style);
    }
  }

  const btn = document.createElement("button");
  btn.id = "yt-adjust-speed-btn";
  btn.className = "ytp-button";
  btn.setAttribute("aria-label", "Playback speed");

  // Build speedometer SVG icon matching YouTube's native 24x24 control icons
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#eee");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  const arc = document.createElementNS(ns, "path");
  arc.setAttribute("d", "M4.93 19.07A10 10 0 1 1 19.07 19.07");
  svg.appendChild(arc);

  const needle = document.createElementNS(ns, "path");
  needle.setAttribute("d", "M12 12l4.5-4.5");
  needle.setAttribute("stroke-width", "2.5");
  svg.appendChild(needle);

  const hub = document.createElementNS(ns, "circle");
  hub.setAttribute("cx", "12");
  hub.setAttribute("cy", "12");
  hub.setAttribute("r", "2.5");
  hub.setAttribute("fill", "#eee");
  svg.appendChild(hub);

  const badge = document.createElement("span");
  badge.id = "yt-adjust-speed-badge";
  badge.textContent = "";
  Object.assign(badge.style, {
    fontSize: "14px",
    fontWeight: "500",
    fontFamily: '"YouTube Noto", Roboto, Arial, Helvetica, sans-serif',
    lineHeight: "1",
    pointerEvents: "none",
    display: "none", // Hidden at default 1x
    color: "#eee",
  });

  Object.assign(btn.style, {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "0",
    width: "40px",
    minWidth: "40px",
    height: "40px",
    padding: "0",
    background: "none",
    border: "none",
    cursor: "pointer",
    color: "#eee",
    opacity: "0.9",
    transition: "opacity 0.15s ease",
    verticalAlign: "middle",
  });

  btn.appendChild(svg);
  btn.appendChild(badge);

  btn.addEventListener("mouseenter", () => {
    btn.style.opacity = "1";
  });
  btn.addEventListener("mouseleave", () => {
    const video = getVideo();
    const isDefault = video && Math.abs(video.playbackRate - 1) < 0.01;
    btn.style.opacity = isDefault ? "0.9" : "1";
  });

  btn.addEventListener("click", () => {
    const video = getVideo();
    state.customPlaybackRate = 1.0;
    state._speedmasterRestoreRate = 0;
    if (video) {
      video.defaultPlaybackRate = 1.0;
      video.playbackRate = 1.0;
      showSpeedOverlay(1.0);
    }
    updateSpeedButton(1.0);
  });

  rightControlsLeft.insertBefore(btn, settingsBtn);

  const video = getVideo();
  bindSpeedVideo(video);
  const currentSpeed = (video && video.playbackRate) ? video.playbackRate : (state.customPlaybackRate || 1.0);
  updateSpeedButton(currentSpeed);
}

/**
 * Updates the speed button badge and hover tooltip text.
 * Only displays text and expands width when speed is not 1x.
 *
 * @param {number} speed - Playback speed multiplier
 * @returns {void}
 */
function updateSpeedButton(speed) {
  const badge = /** @type {HTMLElement | null} */ (document.getElementById("yt-adjust-speed-badge"));
  const btn = /** @type {HTMLElement | null} */ (document.getElementById("yt-adjust-speed-btn"));
  if (!btn) return;

  const isDefault = Math.abs(speed - 1) < 0.01;
  const speedText = `${speed.toFixed(2).replace(/\.?0+$/, "")}x`;

  if (isDefault) {
    if (badge) {
      badge.textContent = "";
      badge.style.display = "none";
    }
    btn.style.width = "40px";
    btn.style.minWidth = "40px";
    btn.style.padding = "0";
    btn.style.gap = "0";
    btn.style.opacity = "0.9";
  } else {
    if (badge) {
      badge.textContent = speedText;
      badge.style.display = "inline";
    }
    btn.style.width = "auto";
    btn.style.minWidth = "42px";
    btn.style.padding = "0 6px";
    btn.style.gap = "3px";
    btn.style.opacity = "1";
  }
}

// =============================================================================
// MODULE 5: Volume Boost (Web Audio API)
// =============================================================================
// Uses an AudioContext + GainNode pipeline to amplify audio to 150% gain.
// createMediaElementSource() can only be called ONCE per <video> element.
// AudioContext requires explicit resume on user gesture if suspended by browser autoplay policy.
// =============================================================================

/**
 * Sets up volume boost button injection if the feature is enabled.
 *
 * @returns {void}
 */
function setupVolumeBoost() {
  if (!state.settings.volumeBoostEnabled) return;
  injectBoostButton();
  // If boost is currently active and YouTube replaced the <video> element during navigation,
  // re-bind the Web Audio graph to the new video element immediately
  if (state.boostActive) {
    const video = getVideo();
    if (video) ensureAudioPipeline(video);
  }
}

/**
 * Injects the boost toggle button next to YouTube's volume area.
 * Includes defensive parentElement checks before insertBefore.
 *
 * @returns {void}
 */
function injectBoostButton() {
  if (document.getElementById("yt-adjust-boost-btn")) return;

  const volumeArea = /** @type {HTMLElement | null} */ (document.querySelector(".ytp-volume-area"));
  if (!volumeArea || !volumeArea.parentElement) return;

  const btn = document.createElement("button");
  btn.id = "yt-adjust-boost-btn";
  btn.className = "ytp-button";
  const pct = Math.round(getBoostGain() * 100);
  btn.setAttribute("aria-label", `Volume boost (${pct}%)`);

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");

  // Left acoustic wave arc
  const leftWave = document.createElementNS(ns, "path");
  leftWave.setAttribute("d", "M4.5 6.5c-2.2 3.5-2.2 7.5 0 11");
  leftWave.setAttribute("stroke-width", "2");
  leftWave.setAttribute("stroke-linecap", "round");
  svg.appendChild(leftWave);

  // Center lightning bolt - prominent, sharp, perfectly centered with zero overlap
  const bolt = document.createElementNS(ns, "path");
  bolt.setAttribute("d", "M13 2.5L7.5 12h4L10.5 21.5L16.5 11h-4z");
  bolt.setAttribute("stroke-width", "1.2");
  bolt.setAttribute("stroke-linejoin", "round");
  bolt.setAttribute("fill", "currentColor");
  svg.appendChild(bolt);

  // Right acoustic wave arc
  const rightWave = document.createElementNS(ns, "path");
  rightWave.setAttribute("d", "M19.5 6.5c2.2 3.5 2.2 7.5 0 11");
  rightWave.setAttribute("stroke-width", "2");
  rightWave.setAttribute("stroke-linecap", "round");
  svg.appendChild(rightWave);

  btn.appendChild(svg);

  Object.assign(btn.style, {
    cursor: "pointer",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    background: "rgba(0, 0, 0, 0.3)",
    margin: "8px 0 8px 12px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    padding: "0",
    color: "rgba(255, 255, 255, 0.9)",
    transition: "background 0.15s ease, color 0.15s ease",
    verticalAlign: "middle",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.background = state.boostActive
      ? "rgba(255, 75, 75, 0.4)"
      : "rgba(255, 255, 255, 0.2)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = state.boostActive
      ? "rgba(255, 75, 75, 0.25)"
      : "rgba(0, 0, 0, 0.3)";
  });

  btn.addEventListener("click", () => {
    toggleBoost();
  });

  // Guarded DOM insertion: ensure parentElement exists before insertBefore
  volumeArea.parentElement.insertBefore(btn, volumeArea.nextSibling);
}

/**
 * Toggles the 150% volume boost on or off.
 * Handles AudioContext resume on user gesture if the audio context is suspended.
 *
 * @returns {void}
 */
function toggleBoost() {
  const video = getVideo();
  if (!video) return;

  if (state.boostActive) {
    if (state.gainNode) state.gainNode.gain.value = 1.0;
    state.boostActive = false;
    updateBoostButtonState(false);
    const player = getPlayer();
    const vol = player && typeof player.getVolume === "function"
      ? player.getVolume()
      : Math.round(video.volume * 100);
    showVolumeOverlay(Math.round(vol));
    console.log("[YT Adjust] Volume boost OFF");
  } else {
    ensureAudioPipeline(video);

    // Browser autoplay policy guard: resume AudioContext on user click if suspended
    if (state.audioContext && state.audioContext.state === "suspended") {
      state.audioContext.resume().catch((resumeErr) => {
        console.warn("[YT Adjust] AudioContext resume failed:", resumeErr);
      });
    }

    const activeGain = getBoostGain();
    if (state.gainNode) state.gainNode.gain.value = activeGain;
    state.boostActive = true;
    updateBoostButtonState(true);

    const player = getPlayer();
    const vol = player && typeof player.getVolume === "function"
      ? player.getVolume()
      : Math.round(video.volume * 100);
    showVolumeOverlay(Math.round(vol * activeGain));
    console.log(`[YT Adjust] Volume boost ON (${Math.round(activeGain * 100)}%)`);
  }
}

/**
 * Creates the Web Audio pipeline (AudioContext -> MediaElementSource -> GainNode -> destination).
 * Reuses the existing pipeline to respect the single-source constraint of createMediaElementSource.
 *
 * @param {HTMLVideoElement} video - Active video element
 * @returns {void}
 */
function ensureAudioPipeline(video) {
  if (state.audioContext && state.mediaSource && state._boostBoundVideo === video) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("[YT Adjust] AudioContext not supported in this browser");
      return;
    }

    if (!state.audioContext) {
      state.audioContext = new AudioContextClass();
    }
    if (!state.gainNode) {
      state.gainNode = state.audioContext.createGain();
      state.gainNode.connect(state.audioContext.destination);
      state.gainNode.gain.value = state.boostActive ? getBoostGain() : 1.0;
    }
    if (state.mediaSource && typeof state.mediaSource.disconnect === "function") {
      try {
        state.mediaSource.disconnect();
      } catch (e) {}
    }

    state.mediaSource = state.audioContext.createMediaElementSource(video);
    state._boostBoundVideo = video;
    state.mediaSource.connect(state.gainNode);

    console.log("[YT Adjust] Audio pipeline created for volume boost");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn("[YT Adjust] Failed to create audio pipeline:", errMsg);
  }
}

/**
 * Updates the visual styling of the volume boost button.
 *
 * @param {boolean} active - Boost status
 * @returns {void}
 */
function updateBoostButtonState(active) {
  const btn = document.getElementById("yt-adjust-boost-btn");
  if (!btn) return;

  btn.style.background = active ? "rgba(255, 75, 75, 0.25)" : "rgba(0, 0, 0, 0.3)";
  btn.style.color = active ? "#ff6b6b" : "rgba(255, 255, 255, 0.8)";
}

// =============================================================================
// MODULE 6: Scroll Mini-Player
// =============================================================================
// Floats the video player in the top-right corner when scrolling past the main player.
// Uses scroll coordinate checks rather than IntersectionObserver to avoid feedback loops.
// =============================================================================

let miniPlayerScrollBound = false;
let isInternalResizeDispatch = false;

/**
 * Deactivates the floating mini-player immediately when entering native fullscreen.
 *
 * @returns {void}
 */
function onMiniPlayerFullscreenChange() {
  if (document.fullscreenElement && state.miniPlayerActive) {
    deactivateMiniPlayer();
  }
}

/**
 * Injects defensive styles ensuring the YouTube video container and video element
 * always fill the player boundary and never collapse to 0px height during scroll transitions.
 *
 * @returns {void}
 */
function ensureVideoContainerStyles() {
  if (document.getElementById("yt-adjust-video-fix")) return;
  const style = document.createElement("style");
  style.id = "yt-adjust-video-fix";
  style.textContent = `
    /* Restrict video sizing overrides strictly to mini-player mode so normal player layout is untouched */
    #movie_player[data-yt-adjust-mini="true"],
    ytd-player[data-yt-adjust-mini="true"] #movie_player {
      width: 100% !important;
      height: 100% !important;
    }
    #movie_player[data-yt-adjust-mini="true"] .html5-video-container,
    ytd-player[data-yt-adjust-mini="true"] .html5-video-container {
      width: 100% !important;
      height: 100% !important;
    }
    #movie_player[data-yt-adjust-mini="true"] .html5-video-container video.html5-main-video,
    ytd-player[data-yt-adjust-mini="true"] .html5-video-container video.html5-main-video {
      width: 100% !important;
      height: 100% !important;
      left: 0px !important;
      top: 0px !important;
      object-fit: contain !important;
    }
    /* Hide channel branding watermark, annotations, info cards, and end screens in mini-player mode */
    ytd-player[data-yt-adjust-mini="true"] .branding-img-container,
    ytd-player[data-yt-adjust-mini="true"] .branding-img,
    ytd-player[data-yt-adjust-mini="true"] .branding-context-container,
    ytd-player[data-yt-adjust-mini="true"] .iv-branding,
    ytd-player[data-yt-adjust-mini="true"] .annotation-type-custom.iv-branding,
    ytd-player[data-yt-adjust-mini="true"] .ytp-featured-watermark,
    ytd-player[data-yt-adjust-mini="true"] .ytp-ce-element,
    ytd-player[data-yt-adjust-mini="true"] .ytp-cards-teaser,
    ytd-player[data-yt-adjust-mini="true"] .ytp-cards-button,
    ytd-player[data-yt-adjust-mini="true"] .ytp-paid-content-overlay,
    ytd-player[data-yt-adjust-mini="true"] .ytp-suggested-action,
    #movie_player[data-yt-adjust-mini="true"] .branding-img-container,
    #movie_player[data-yt-adjust-mini="true"] .branding-img,
    #movie_player[data-yt-adjust-mini="true"] .branding-context-container,
    #movie_player[data-yt-adjust-mini="true"] .iv-branding,
    #movie_player[data-yt-adjust-mini="true"] .annotation-type-custom.iv-branding,
    #movie_player[data-yt-adjust-mini="true"] .ytp-featured-watermark,
    #movie_player[data-yt-adjust-mini="true"] .ytp-ce-element,
    #movie_player[data-yt-adjust-mini="true"] .ytp-cards-teaser,
    #movie_player[data-yt-adjust-mini="true"] .ytp-cards-button,
    #movie_player[data-yt-adjust-mini="true"] .ytp-paid-content-overlay,
    #movie_player[data-yt-adjust-mini="true"] .ytp-suggested-action,
    /* Hide giant seekbar preview cards, thumbnail tooltips, and fine scrubbing in mini-player mode */
    ytd-player[data-yt-adjust-mini="true"] .ytp-tooltip-image,
    ytd-player[data-yt-adjust-mini="true"] .ytp-tooltip-edu,
    ytd-player[data-yt-adjust-mini="true"] .ytp-tooltip-title,
    ytd-player[data-yt-adjust-mini="true"] .ytp-tooltip-bg,
    ytd-player[data-yt-adjust-mini="true"] .ytp-fine-scrubbing-container,
    ytd-player[data-yt-adjust-mini="true"] .ytp-storyboard-framepreview,
    #movie_player[data-yt-adjust-mini="true"] .ytp-tooltip-image,
    #movie_player[data-yt-adjust-mini="true"] .ytp-tooltip-edu,
    #movie_player[data-yt-adjust-mini="true"] .ytp-tooltip-title,
    #movie_player[data-yt-adjust-mini="true"] .ytp-tooltip-bg,
    #movie_player[data-yt-adjust-mini="true"] .ytp-fine-scrubbing-container,
    #movie_player[data-yt-adjust-mini="true"] .ytp-storyboard-framepreview {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
      visibility: hidden !important;
    }
    /* Restrain bottom controls and seekbar within mini-player bounds */
    ytd-player[data-yt-adjust-mini="true"] .ytp-chrome-bottom,
    #movie_player[data-yt-adjust-mini="true"] .ytp-chrome-bottom {
      width: calc(100% - 24px) !important;
      left: 12px !important;
    }
    /* Hide chapter title in mini-player to avoid crowding controls */
    ytd-player[data-yt-adjust-mini="true"] .ytp-chapter-container,
    #movie_player[data-yt-adjust-mini="true"] .ytp-chapter-container {
      display: none !important;
    }
  `;
  const styleTarget = document.head || document.documentElement || document.body;
  if (styleTarget && typeof styleTarget.appendChild === "function") {
    styleTarget.appendChild(style);
  }
}

/**
 * Handles window resize while the mini-player is active.
 * Dynamically updates the preserved container minHeight and placeholder height
 * to match the natural dimensions calculated for the current viewport width.
 * Prevents layout jumping when scrolling back up after resizing the browser.
 *
 * @returns {void}
 */
function onMiniPlayerWindowResize() {
  if (isInternalResizeDispatch) return;
  if (!state.miniPlayerActive) return;
  const ytdPlayer = getYtdPlayer();
  if (!ytdPlayer) return;

  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const playerStyle = (player && typeof window.getComputedStyle === "function") ? window.getComputedStyle(player) : null;
  const isStandard = Boolean(
    player &&
    player.contains(ytdPlayer) &&
    playerStyle?.display !== "none" &&
    (player.offsetHeight > 0 || player.offsetHeight === undefined)
  );
  const anchor = state._miniPlayerAnchor || (isStandard ? player : ytdPlayer.parentElement);
  if (!anchor) return;

  const video = getVideo();
  const aspectRatio = (video && video.videoWidth && video.videoHeight)
    ? (video.videoHeight / video.videoWidth)
    : (9 / 16);

  const containerWidth = anchor.clientWidth || anchor.offsetWidth;
  if (containerWidth > 0) {
    let newHeight = Math.round(containerWidth * aspectRatio);
    // In Theater Mode, respect YouTube's max-height: calc(100vh - 169px) constraint
    // so resizing never inflates the theater container to full 100vh
    if (!isStandard && typeof window !== "undefined" && window.innerHeight > 0) {
      const maxTheaterHeight = Math.max(480, window.innerHeight - 169);
      newHeight = Math.min(newHeight, maxTheaterHeight);
    }
    if (isStandard) {
      if (player) player.style.minHeight = `${newHeight}px`;
      const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
      if (playerOuter) playerOuter.style.minHeight = `${newHeight}px`;
    } else if (state._miniPlayerAnchor && state._miniPlayerAnchor !== ytdPlayer.parentElement) {
      state._miniPlayerAnchor.style.minHeight = `${newHeight}px`;
    }
    if (ytdPlayer.parentElement) {
      ytdPlayer.parentElement.style.minHeight = `${newHeight}px`;
    }
    const placeholder = document.getElementById("yt-adjust-player-placeholder");
    if (placeholder) {
      placeholder.style.height = `${newHeight}px`;
    }
    // Invalidate pre-resize inline video pixel coordinates so deactivation recalculates containment,
    // but NEVER overwrite state._savedLayoutStyles (which must restore empty inline minHeight on exit)
    state._savedVideoStyles = null;
  }
}

/**
 * Synchronizes the preserved layout minHeight and placeholder if the user toggles
 * Theater Mode (presses 't') while the mini-player is already floating.
 * When YouTube moves ytd-player between #player and #full-bleed-container during an
 * active mini-player session, this transfers the reserved height to the new active
 * container and clears the old one so scrolling back up deactivates cleanly.
 *
 * @param {HTMLElement} [ytdPlayerArg]
 * @returns {void}
 */
function syncMiniPlayerTheaterToggle(ytdPlayerArg) {
  if (!state.miniPlayerActive) return;
  const ytdPlayer = ytdPlayerArg || getYtdPlayer();
  if (!ytdPlayer || !ytdPlayer.parentElement) return;

  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const fullBleed = /** @type {HTMLElement | null} */ (
    document.querySelector("#full-bleed-container") ||
    document.querySelector("#player-full-bleed-container") ||
    document.querySelector("#player-theater-container")
  );

  // If the current anchor still contains ytdPlayer, no layout container flip occurred
  if (
    state._miniPlayerAnchor &&
    typeof state._miniPlayerAnchor.contains === "function" &&
    state._miniPlayerAnchor.contains(ytdPlayer)
  ) {
    return;
  }

  const placeholder = document.getElementById("yt-adjust-player-placeholder");
  const currentHeightStr = placeholder?.style.height || (state._miniPlayerAnchor?.style.minHeight) || "560px";

  if (fullBleed && fullBleed.contains(ytdPlayer)) {
    // Switched from Standard Mode (#player) into Theater Mode (#full-bleed-container)
    if (player) {
      player.style.minHeight = state._savedLayoutStyles?.playerMinHeight || "";
      player.style.position = state._savedLayoutStyles?.playerPosition || "";
      player.style.zIndex = state._savedLayoutStyles?.playerZIndex || "";
    }
    const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
    if (playerOuter) {
      playerOuter.style.minHeight = state._savedLayoutStyles?.playerOuterMinHeight || "";
    }

    const maxTheaterH = (typeof window !== "undefined" && window.innerHeight > 0)
      ? Math.max(480, window.innerHeight - 169)
      : 695;
    const width = fullBleed.clientWidth || fullBleed.offsetWidth || 1280;
    const theaterH = Math.min(maxTheaterH, Math.round(width * 9 / 16));

    fullBleed.style.minHeight = `${theaterH}px`;
    fullBleed.style.position = "relative";
    fullBleed.style.zIndex = "9999";
    ytdPlayer.parentElement.style.minHeight = `${theaterH}px`;
    ytdPlayer.parentElement.style.zIndex = "9999";
    if (placeholder) {
      placeholder.style.height = `${theaterH}px`;
      if (placeholder.parentElement !== ytdPlayer.parentElement) {
        ytdPlayer.parentElement.insertBefore(placeholder, ytdPlayer);
      }
    }
    state._miniPlayerAnchor = fullBleed;
    state._savedVideoStyles = null;
  } else if (player && player.contains(ytdPlayer)) {
    // Switched from Theater Mode (#full-bleed-container) into Standard Mode (#player)
    if (fullBleed) {
      fullBleed.style.minHeight = state._savedLayoutStyles?.fullBleedMinHeight || "";
      fullBleed.style.position = state._savedLayoutStyles?.fullBleedPosition || "";
      fullBleed.style.zIndex = state._savedLayoutStyles?.fullBleedZIndex || "";
    }
    const playerFullBleed = /** @type {HTMLElement | null} */ (document.querySelector("#player-full-bleed-container"));
    if (playerFullBleed) {
      playerFullBleed.style.minHeight = state._savedLayoutStyles?.playerFullBleedMinHeight || "";
    }

    const width = player.clientWidth || player.offsetWidth || 854;
    const stdH = width > 0 ? Math.round(width * 9 / 16) : parseInt(currentHeightStr, 10) || 480;

    player.style.minHeight = `${stdH}px`;
    player.style.position = "relative";
    player.style.zIndex = "9999";
    const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
    if (playerOuter) {
      playerOuter.style.minHeight = `${stdH}px`;
    }
    ytdPlayer.parentElement.style.minHeight = `${stdH}px`;
    ytdPlayer.parentElement.style.zIndex = "9999";
    if (placeholder) {
      placeholder.style.height = `${stdH}px`;
      if (placeholder.parentElement !== ytdPlayer.parentElement) {
        ytdPlayer.parentElement.insertBefore(placeholder, ytdPlayer);
      }
    }
    state._miniPlayerAnchor = player;
    state._savedVideoStyles = null;
  }
}

/**
 * Event handler for YouTube's yt-set-theater-mode-enabled custom event.
 *
 * @returns {void}
 */
function onMiniPlayerTheaterToggle() {
  syncMiniPlayerTheaterToggle();
}

/**
 * Parses a YouTube `t` or `start` query parameter value (e.g. "95", "95s", "1m30s", "1h2m3s")
 * into seconds. Returns NaN if the value cannot be parsed.
 *
 * @param {string | null} rawTime
 * @returns {number}
 */
function parseYouTubeTimeParam(rawTime) {
  if (!rawTime || typeof rawTime !== "string") return NaN;
  const trimmed = rawTime.trim().toLowerCase();
  if (/^\d+(\.\d+)?s?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }
  const hmsMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s?)?$/);
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    const hours = hmsMatch[1] ? parseInt(hmsMatch[1], 10) : 0;
    const minutes = hmsMatch[2] ? parseInt(hmsMatch[2], 10) : 0;
    const secs = hmsMatch[3] ? parseFloat(hmsMatch[3]) : 0;
    return hours * 3600 + minutes * 60 + secs;
  }
  return NaN;
}

/**
 * Intercepts clicks on same-video timestamp links (e.g. "2:15" in comments or description)
 * while the floating mini-player is active so the video seeks in-place without YouTube
 * scrolling the page back to the top and closing the mini-player.
 *
 * @param {MouseEvent} e
 * @returns {void}
 */
function onMiniPlayerTimestampClick(e) {
  if (!state.miniPlayerActive || !state.settings.miniPlayerEnabled) return;
  if (!e || e.defaultPrevented) return;
  if (typeof e.button === "number" && e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const anchor = /** @type {HTMLAnchorElement | null} */ (
    target.tagName === "A" ? target : (typeof target.closest === "function" ? target.closest("a") : null)
  );
  if (!anchor) return;
  const anchorTarget = anchor.target || (typeof anchor.getAttribute === "function" ? anchor.getAttribute("target") : "");
  if (anchorTarget === "_blank") return;

  const href = anchor.href || (typeof anchor.getAttribute === "function" ? anchor.getAttribute("href") : "") || "";
  if (!href || !href.includes("/watch")) return;

  const currentVideoId = state.currentVideoId || new URLSearchParams(location.search).get("v");
  if (!currentVideoId) return;

  let seconds = NaN;
  try {
    const parsedUrl = new URL(href, location.origin || "https://www.youtube.com");
    if (parsedUrl.pathname !== "/watch") return;
    if (parsedUrl.searchParams.get("v") !== currentVideoId) return;
    const tVal = parsedUrl.searchParams.get("t") || parsedUrl.searchParams.get("start");
    seconds = parseYouTubeTimeParam(tVal);
  } catch (_) {
    if (!href.includes(`v=${currentVideoId}`)) return;
    const timeMatch = href.match(/[?&](?:t|start)=([^&#]+)/);
    seconds = timeMatch ? parseYouTubeTimeParam(timeMatch[1]) : NaN;
  }

  if (!Number.isFinite(seconds) || seconds < 0) return;

  if (typeof e.preventDefault === "function") e.preventDefault();
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

  const player = getPlayer();
  const video = getVideo();
  if (player && typeof player.seekTo === "function") {
    try {
      player.seekTo(seconds, true);
    } catch (_) {}
  }
  if (video) {
    video.currentTime = seconds;
  }
}

/**
 * Attaches scroll, resize, theater-toggle, timestamp-click, and fullscreen listeners for the mini-player.
 *
 * @returns {void}
 */
function setupMiniPlayer() {
  if (!state.settings.miniPlayerEnabled) return;
  ensureVideoContainerStyles();
  if (miniPlayerScrollBound) return;

  document.addEventListener("scroll", onMiniPlayerScroll, { passive: true });
  window.addEventListener("resize", onMiniPlayerWindowResize, { passive: true });
  document.addEventListener("fullscreenchange", onMiniPlayerFullscreenChange);
  document.addEventListener("yt-set-theater-mode-enabled", onMiniPlayerTheaterToggle);
  document.addEventListener("click", onMiniPlayerTimestampClick, true);
  miniPlayerScrollBound = true;
}

/**
 * Dynamically resolves the active, visible layout container hosting the video player.
 * Guards against collapsed, hidden, or 0-height elements (such as when YouTube hides
 * #player in favor of #full-bleed-container when opening chapters, side panels, or responsive resizing).
 *
 * @param {HTMLElement} ytdPlayer
 * @returns {HTMLElement | null}
 */
function getPlayerFlowAnchor(ytdPlayer) {
  /**
   * Checks whether an element is actively rendered and not display:none or 0-height.
   * @param {HTMLElement | null} el
   * @returns {boolean}
   */
  const isVisible = (el) => {
    if (!el) return false;
    if (typeof window.getComputedStyle === "function") {
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return el.offsetHeight > 0 || el.offsetHeight === undefined;
  };

  // If we have an active cached anchor that still contains ytdPlayer and is visible, return immediately without DOM queries
  if (
    state.miniPlayerActive &&
    state._miniPlayerAnchor &&
    (typeof state._miniPlayerAnchor.contains !== "function" || state._miniPlayerAnchor.contains(ytdPlayer)) &&
    isVisible(state._miniPlayerAnchor)
  ) {
    return state._miniPlayerAnchor;
  }

  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const fullBleed = /** @type {HTMLElement | null} */ (
    document.querySelector("#full-bleed-container") ||
    document.querySelector("#player-full-bleed-container") ||
    document.querySelector("#player-theater-container")
  );

  if (player && player.contains(ytdPlayer) && isVisible(player)) {
    return player;
  }
  if (fullBleed && fullBleed.contains(ytdPlayer) && isVisible(fullBleed)) {
    return fullBleed;
  }

  if (isVisible(fullBleed)) {
    return fullBleed;
  }
  if (isVisible(player)) {
    return player;
  }

  const placeholder = document.getElementById("yt-adjust-player-placeholder");
  if (placeholder && isVisible(placeholder)) {
    return placeholder;
  }

  return ytdPlayer.parentElement || null;
}

/**
 * Evaluates scroll position against the player container boundary.
 * Activates or deactivates the floating mini-player accordingly.
 * Incorporates hysteresis to prevent rapid jitter/jumping near the trigger threshold.
 *
 * @returns {void}
 */
function onMiniPlayerScroll() {
  if (!state.settings.miniPlayerEnabled) return;
  if (location.pathname !== "/watch") {
    if (state.miniPlayerActive) deactivateMiniPlayer();
    return;
  }

  // Never keep or activate mini-player during active fullscreen playback
  if (document.fullscreenElement) {
    if (state.miniPlayerActive) deactivateMiniPlayer();
    return;
  }

  // O(1) fast-path when scrolling near the very top of the page while mini-player is inactive:
  // at scrollY < 40px, the player container bottom is guaranteed to be well below the 56px threshold.
  if (
    !state.miniPlayerActive &&
    !state.miniPlayerDismissed &&
    typeof window !== "undefined" &&
    typeof window.scrollY === "number" &&
    window.scrollY >= 0 &&
    window.scrollY < 40
  ) {
    return;
  }

  const ytdPlayer = getYtdPlayer();
  if (!ytdPlayer) return;

  if (state.miniPlayerActive) {
    syncMiniPlayerTheaterToggle(ytdPlayer);
    // O(1) fast-path when scrolling deep through comments (> 1400px) while mini-player is already active:
    // the player container is far above the viewport, so skip DOM getBoundingClientRect() reflows.
    if (
      typeof window !== "undefined" &&
      typeof window.scrollY === "number" &&
      window.scrollY > 1400
    ) {
      return;
    }
  }

  const refElement = getPlayerFlowAnchor(ytdPlayer);
  if (!refElement) return;

  const rect = refElement.getBoundingClientRect();
  // If the resolved element is not currently in layout (0 height), do not trigger
  if (rect.height === 0 && rect.bottom === 0) return;

  // Trigger activation when player container bottom passes above masthead threshold (56px).
  // Use a hysteresis buffer for deactivation (rect.bottom >= 80px) to prevent
  // rapid jitter, jumping, and toggling when hovering near the boundary.
  if (rect.bottom < 56) {
    if (!state.miniPlayerDismissed && !state.miniPlayerActive && !document.pictureInPictureElement) {
      activateMiniPlayer();
    }
  } else if (rect.bottom >= 80) {
    if (state.miniPlayerActive) {
      deactivateMiniPlayer();
    }
    state.miniPlayerDismissed = false;
  }
}

/**
 * Applies in-place fixed positioning to ytd-player without DOM reparenting.
 * Preserves layout height on ancestor containers and inserts an in-flow placeholder
 * so the page content below the player never suddenly collapses or jumps.
 * Omits 'transition: all' to prevent full-screen expansion flashes and jumping during activation.
 *
 * @returns {void}
 */
function activateMiniPlayer() {
  if (state.miniPlayerActive) return;
  if (location.pathname !== "/watch") return;
  if (document.fullscreenElement) return;

  const ytdPlayer = getYtdPlayer();
  if (!ytdPlayer || !ytdPlayer.parentElement) return;

  const playerContainer = ytdPlayer.parentElement;
  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const playerStyle = (player && typeof window.getComputedStyle === "function") ? window.getComputedStyle(player) : null;
  const isStandardPlayer = Boolean(
    player &&
    player.contains(ytdPlayer) &&
    playerStyle?.display !== "none" &&
    (player.offsetHeight > 0 || player.offsetHeight === undefined)
  );
  const playerOuter = isStandardPlayer ? /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer")) : null;

  const fullBleed = /** @type {HTMLElement | null} */ (
    document.querySelector("#full-bleed-container") ||
    document.querySelector("#player-full-bleed-container") ||
    document.querySelector("#player-theater-container")
  );
  const playerFullBleed = /** @type {HTMLElement | null} */ (document.querySelector("#player-full-bleed-container"));
  const playerTheater = /** @type {HTMLElement | null} */ (document.querySelector("#player-theater-container"));

  const moviePlayer = getPlayer();
  const container = /** @type {HTMLElement | null} */ (document.querySelector(".html5-video-container"));
  const video = getVideo();

  // Capture ALL pre-existing inline layout and video dimensions BEFORE any style mutation or setInternalSize() call
  state._savedLayoutStyles = {
    playerMinHeight: player ? player.style.minHeight : "",
    playerPosition: player ? player.style.position : "",
    playerZIndex: player ? player.style.zIndex : "",
    playerOuterMinHeight: playerOuter ? playerOuter.style.minHeight : "",
    playerContainerMinHeight: playerContainer ? playerContainer.style.minHeight : "",
    playerContainerPosition: playerContainer ? playerContainer.style.position : "",
    playerContainerZIndex: playerContainer ? playerContainer.style.zIndex : "",
    fullBleedMinHeight: fullBleed ? fullBleed.style.minHeight : "",
    fullBleedPosition: fullBleed ? fullBleed.style.position : "",
    fullBleedZIndex: fullBleed ? fullBleed.style.zIndex : "",
    playerFullBleedMinHeight: playerFullBleed ? playerFullBleed.style.minHeight : "",
    playerTheaterMinHeight: playerTheater ? playerTheater.style.minHeight : "",
  };

  if (moviePlayer && !state._savedMoviePlayerStyles) {
    state._savedMoviePlayerStyles = {
      width: moviePlayer.style.width || "",
      height: moviePlayer.style.height || "",
    };
  }
  if (container && !state._savedContainerStyles) {
    state._savedContainerStyles = {
      width: container.style.width || "",
      height: container.style.height || "",
    };
  }
  if (video && !state._savedVideoStyles) {
    state._savedVideoStyles = {
      width: video.style.width || "",
      height: video.style.height || "",
      left: video.style.left || "",
      top: video.style.top || "",
      objectFit: video.style.objectFit || "",
    };
  }

  // Measure player height accurately before applying fixed positioning.
  // In Theater Mode, clamp to #full-bleed-container height so the placeholder never exceeds calc(100vh - 169px).
  const ytdRect = ytdPlayer.getBoundingClientRect();
  const playerRect = (isStandardPlayer && player) ? player.getBoundingClientRect() : null;
  const fullBleedRect = (!isStandardPlayer && fullBleed) ? fullBleed.getBoundingClientRect() : null;
  const height = (playerRect && playerRect.height > 0)
    ? playerRect.height
    : (fullBleedRect && fullBleedRect.height > 0
      ? (ytdRect.height > 0 ? Math.min(fullBleedRect.height, ytdRect.height) : fullBleedRect.height)
      : (ytdRect.height > 0 ? ytdRect.height : (ytdPlayer.offsetHeight || 560)));

  // Maintain minimum height on the exact flow container hierarchy:
  // In standard layout, preserve #player, #player-container-outer, and playerContainer.
  // In theater mode, NEVER touch #player (which sits empty in #primary) — only preserve fullBleed and playerContainer.
  if (isStandardPlayer) {
    if (player) {
      player.style.minHeight = `${height}px`;
      player.style.position = "relative";
      player.style.zIndex = "9999";
    }
    if (playerOuter) {
      playerOuter.style.minHeight = `${height}px`;
    }
    state._miniPlayerAnchor = player;
  } else {
    if (fullBleed) {
      fullBleed.style.minHeight = `${height}px`;
      fullBleed.style.position = "relative";
      fullBleed.style.zIndex = "9999";
      state._miniPlayerAnchor = fullBleed;
    } else {
      state._miniPlayerAnchor = playerContainer;
    }
  }

  if (playerContainer) {
    playerContainer.style.minHeight = `${height}px`;
    playerContainer.style.zIndex = "9999";
  }

  // Insert an in-flow placeholder element in the player container to preserve layout space
  // even if parent styling uses flex or absolute positioning
  let placeholder = document.getElementById("yt-adjust-player-placeholder");
  if (!placeholder && ytdPlayer.parentElement) {
    placeholder = document.createElement("div");
    placeholder.id = "yt-adjust-player-placeholder";
    placeholder.style.width = "100%";
    placeholder.style.height = `${height}px`;
    placeholder.style.display = "block";
    placeholder.style.boxSizing = "border-box";
    placeholder.style.pointerEvents = "none";
    placeholder.style.visibility = "hidden";
    ytdPlayer.parentElement.insertBefore(placeholder, ytdPlayer);
  }

  // Apply mini-player fixed styles directly without 'transition: all 0.25s ease'
  // which caused the player to stretch across the viewport and jump during activation.
  // Promote to dedicated GPU compositor layer with will-change and transform: translateZ(0)
  // to eliminate sub-pixel repaint jitter and flickering during high-DPI display scrolling.
  Object.assign(ytdPlayer.style, {
    position: "fixed",
    top: "72px",
    right: "16px",
    width: "480px",
    maxWidth: "calc(100vw - 32px)",
    height: "270px",
    zIndex: "9999",
    backgroundColor: "#000",
    borderRadius: "8px",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.6)",
    overflow: "hidden",
    willChange: "transform",
    transform: "translateZ(0)",
    backfaceVisibility: "hidden",
  });

  ensureVideoContainerStyles();
  if (typeof ytdPlayer.setAttribute === "function") {
    ytdPlayer.setAttribute("data-yt-adjust-mini", "true");
  }

  if (moviePlayer) {
    if (typeof moviePlayer.setAttribute === "function") {
      moviePlayer.setAttribute("data-yt-adjust-mini", "true");
    }
    Object.assign(moviePlayer.style, {
      width: "100%",
      height: "100%",
    });
    if (typeof moviePlayer.setInternalSize === "function") {
      try {
        moviePlayer.setInternalSize();
      } catch (e) {}
    }
  }

  // Ensure video container matches player bounds so video height is not 0px
  if (container) {
    Object.assign(container.style, {
      width: "100%",
      height: "100%",
    });
  }

  if (video) {
    Object.assign(video.style, {
      width: "100%",
      height: "100%",
      left: "0px",
      top: "0px",
      objectFit: "contain",
    });
  }

  // Inject close button
  if (!document.getElementById("yt-adjust-mp-close")) {
    const closeBtn = document.createElement("button");
    closeBtn.id = "yt-adjust-mp-close";
    closeBtn.textContent = "\u2715";
    Object.assign(closeBtn.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      background: "rgba(0, 0, 0, 0.7)",
      color: "#fff",
      border: "none",
      borderRadius: "50%",
      width: "28px",
      height: "28px",
      fontSize: "14px",
      cursor: "pointer",
      zIndex: "10000",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "background 0.15s ease",
    });

    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = "rgba(255, 255, 255, 0.2)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "rgba(0, 0, 0, 0.7)";
    });

    closeBtn.addEventListener("click", () => {
      state.miniPlayerDismissed = true;
      deactivateMiniPlayer();
    });

    ytdPlayer.appendChild(closeBtn);
  }

  state.miniPlayerActive = true;
  console.log("[YT Adjust] Mini-player activated");
}

/**
 * Ensures the restored video and movie_player do not exceed their active layout container
 * (such as #full-bleed-container in Theater Mode where max-height is calc(100vh - 169px)).
 *
 * @param {HTMLElement} ytdPlayer
 * @param {HTMLElement | null} moviePlayer
 * @param {HTMLVideoElement | null} video
 * @param {Record<string, string> | null | undefined} savedVideoStyles
 * @param {Record<string, string> | null | undefined} savedMoviePlayerStyles
 * @returns {void}
 */
function enforcePlayerContainment(ytdPlayer, moviePlayer, video, savedVideoStyles, savedMoviePlayerStyles) {
  if (!video) return;

  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const fullBleed = /** @type {HTMLElement | null} */ (
    document.querySelector("#full-bleed-container") ||
    document.querySelector("#player-full-bleed-container") ||
    document.querySelector("#player-theater-container")
  );
  const isStandard = Boolean(
    player &&
    player.contains(ytdPlayer) &&
    (player.clientHeight > 0 || player.offsetHeight > 0)
  );
  const anchorEl = isStandard
    ? player
    : ((fullBleed && (fullBleed.clientHeight > 0 || fullBleed.offsetHeight > 0))
      ? fullBleed
      : (ytdPlayer.parentElement || player || fullBleed));

  const cWidth = anchorEl ? (anchorEl.clientWidth || anchorEl.offsetWidth || 0) : 0;
  const cHeight = anchorEl ? (anchorEl.clientHeight || anchorEl.offsetHeight || 0) : 0;
  if (!(cWidth > 0 && cHeight > 0)) return;

  // Guard #movie_player against inline height blowout exceeding the container
  if (moviePlayer && moviePlayer.style.height) {
    const mpH = parseFloat(moviePlayer.style.height);
    if (!Number.isNaN(mpH) && mpH > cHeight + 2) {
      const savedMpHeightStr = savedMoviePlayerStyles?.height || "";
      const savedMpH = savedMpHeightStr ? parseFloat(savedMpHeightStr) : NaN;
      moviePlayer.style.height = (!Number.isNaN(savedMpH) && savedMpH <= cHeight + 2)
        ? savedMpHeightStr
        : "";
    }
  }

  const curW = parseFloat(video.style.width);
  const curH = parseFloat(video.style.height);
  const exceedsContainer = (!Number.isNaN(curH) && curH > cHeight + 2) || (!Number.isNaN(curW) && curW > cWidth + 2);
  const missingPixelDims = !savedVideoStyles && (Number.isNaN(curW) || Number.isNaN(curH) || video.style.width.endsWith("%") || video.style.height.endsWith("%"));

  if (exceedsContainer || missingPixelDims) {
    const videoAspect = (video.videoWidth && video.videoHeight)
      ? (video.videoWidth / video.videoHeight)
      : (16 / 9);
    let fitW = cWidth;
    let fitH = Math.round(cWidth / videoAspect);
    if (fitH > cHeight) {
      fitH = cHeight;
      fitW = Math.round(cHeight * videoAspect);
    }
    video.style.width = `${fitW}px`;
    video.style.height = `${fitH}px`;
    video.style.left = `${Math.max(0, Math.round((cWidth - fitW) / 2))}px`;
    video.style.top = `${Math.max(0, Math.round((cHeight - fitH) / 2))}px`;
    video.style.objectFit = savedVideoStyles?.objectFit || "contain";
  }
}

/**
 * Restores ytd-player in-place and clears mini-player inline styles.
 * Restores minHeight on layout containers (#player, #player-theater-container, #full-bleed-container)
 * and removes placeholder element.
 * Triggers layout recalculation so YouTube restores native video dimensions without black screen or Theater Mode blowout.
 *
 * @returns {void}
 */
function deactivateMiniPlayer() {
  if (!state.miniPlayerActive) return;
  // Flip state flag immediately so resize/scroll listeners cannot re-enter during restoration
  state.miniPlayerActive = false;

  const savedVideoStyles = state._savedVideoStyles;
  const savedContainerStyles = state._savedContainerStyles;
  const savedMoviePlayerStyles = state._savedMoviePlayerStyles;
  const savedLayoutStyles = state._savedLayoutStyles;

  state._savedVideoStyles = null;
  state._savedContainerStyles = null;
  state._savedMoviePlayerStyles = null;
  state._savedLayoutStyles = null;

  const ytdPlayer = getYtdPlayer();
  if (ytdPlayer) {
    if (typeof ytdPlayer.removeAttribute === "function") {
      ytdPlayer.removeAttribute("data-yt-adjust-mini");
    }
    ytdPlayer.style.position = "";
    ytdPlayer.style.top = "";
    ytdPlayer.style.right = "";
    ytdPlayer.style.width = "";
    ytdPlayer.style.maxWidth = "";
    ytdPlayer.style.height = "";
    ytdPlayer.style.zIndex = "";
    ytdPlayer.style.backgroundColor = "";
    ytdPlayer.style.borderRadius = "";
    ytdPlayer.style.boxShadow = "";
    ytdPlayer.style.overflow = "";
    ytdPlayer.style.transition = "";
    ytdPlayer.style.willChange = "";
    ytdPlayer.style.transform = "";
    ytdPlayer.style.backfaceVisibility = "";

    const playerContainer = ytdPlayer.parentElement;
    if (playerContainer) {
      playerContainer.style.minHeight = savedLayoutStyles?.playerContainerMinHeight || "";
      playerContainer.style.position = savedLayoutStyles?.playerContainerPosition || "";
      playerContainer.style.zIndex = savedLayoutStyles?.playerContainerZIndex || "";
    }

    const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
    if (player) {
      player.style.minHeight = savedLayoutStyles?.playerMinHeight || "";
      player.style.position = savedLayoutStyles?.playerPosition || "";
      player.style.zIndex = savedLayoutStyles?.playerZIndex || "";
    }

    const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
    if (playerOuter) {
      playerOuter.style.minHeight = savedLayoutStyles?.playerOuterMinHeight || "";
    }

    const fullBleed = /** @type {HTMLElement | null} */ (
      document.querySelector("#full-bleed-container") ||
      document.querySelector("#player-full-bleed-container") ||
      document.querySelector("#player-theater-container")
    );
    if (fullBleed) {
      fullBleed.style.position = savedLayoutStyles?.fullBleedPosition || "";
      fullBleed.style.zIndex = savedLayoutStyles?.fullBleedZIndex || "";
      fullBleed.style.minHeight = savedLayoutStyles?.fullBleedMinHeight || "";
    }

    const playerFullBleed = /** @type {HTMLElement | null} */ (document.querySelector("#player-full-bleed-container"));
    if (playerFullBleed && playerFullBleed !== fullBleed && playerFullBleed !== playerContainer) {
      playerFullBleed.style.minHeight = savedLayoutStyles?.playerFullBleedMinHeight || "";
    }

    const playerTheater = /** @type {HTMLElement | null} */ (document.querySelector("#player-theater-container"));
    if (playerTheater && playerTheater !== fullBleed && playerTheater !== playerContainer) {
      playerTheater.style.minHeight = savedLayoutStyles?.playerTheaterMinHeight || "";
    }

    if (state._miniPlayerAnchor) {
      state._miniPlayerAnchor = null;
    }

    const placeholder = document.getElementById("yt-adjust-player-placeholder");
    if (placeholder) {
      placeholder.remove();
    }

    const container = /** @type {HTMLElement | null} */ (document.querySelector(".html5-video-container"));
    if (container) {
      container.style.width = savedContainerStyles?.width || "";
      container.style.height = savedContainerStyles?.height || "";
    }

    const moviePlayer = getPlayer();
    if (moviePlayer) {
      if (typeof moviePlayer.removeAttribute === "function") {
        moviePlayer.removeAttribute("data-yt-adjust-mini");
      }
      moviePlayer.style.width = savedMoviePlayerStyles?.width || "";
      moviePlayer.style.height = savedMoviePlayerStyles?.height || "";
    }

    const video = getVideo();
    if (video) {
      if (savedVideoStyles && savedVideoStyles.width && savedVideoStyles.height) {
        // Faithfully restore YouTube's pre-existing inline dimensions
        video.style.width = savedVideoStyles.width;
        video.style.height = savedVideoStyles.height;
        video.style.left = savedVideoStyles.left;
        video.style.top = savedVideoStyles.top;
        video.style.objectFit = savedVideoStyles.objectFit;
      } else {
        video.style.width = "";
        video.style.height = "";
        video.style.left = "";
        video.style.top = "";
        video.style.objectFit = "";
        enforcePlayerContainment(ytdPlayer, moviePlayer, video, null, savedMoviePlayerStyles);
      }
    }

    // Notify YouTube to recalculate video dimensions and prevent black frame
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      isInternalResizeDispatch = true;
      try {
        const resizeEvt = typeof Event === "function" ? new Event("resize") : null;
        if (resizeEvt) window.dispatchEvent(resizeEvt);
      } catch (evtErr) {
        // Safe fallback in test environments
      } finally {
        isInternalResizeDispatch = false;
      }
    }
    if (moviePlayer && typeof moviePlayer.setInternalSize === "function") {
      try {
        moviePlayer.setInternalSize();
      } catch (e) {}
    }

    // Verify that YouTube's resize/setInternalSize did not blow out video dimensions past Theater/Standard container bounds
    enforcePlayerContainment(ytdPlayer, moviePlayer, video, savedVideoStyles, savedMoviePlayerStyles);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (!state.miniPlayerActive) {
          enforcePlayerContainment(ytdPlayer, moviePlayer, getVideo(), savedVideoStyles, savedMoviePlayerStyles);
        }
      });
    }
  }

  const closeBtn = document.getElementById("yt-adjust-mp-close");
  if (closeBtn) closeBtn.remove();
}

/**
 * Removes mini-player listeners and deactivates the UI when navigating away from watch pages.
 * Cleans up placeholder if left in DOM.
 *
 * @returns {void}
 */
function teardownMiniPlayer() {
  if (miniPlayerScrollBound) {
    document.removeEventListener("scroll", onMiniPlayerScroll);
    window.removeEventListener("resize", onMiniPlayerWindowResize);
    document.removeEventListener("fullscreenchange", onMiniPlayerFullscreenChange);
    document.removeEventListener("yt-set-theater-mode-enabled", onMiniPlayerTheaterToggle);
    document.removeEventListener("click", onMiniPlayerTimestampClick, true);
    miniPlayerScrollBound = false;
  }
  deactivateMiniPlayer();
  const placeholder = document.getElementById("yt-adjust-player-placeholder");
  if (placeholder) {
    placeholder.remove();
  }
  state.miniPlayerDismissed = false;
}

// =============================================================================
// 7. PICTURE-IN-PICTURE (Alt+P and Auto-PiP on Tab Switch)
// =============================================================================

let pipInitialized = false;
let pipToggling = false;
let autoPipToggling = false;
let recoveringOrphanedPip = false;
let lastOrphanedPipRecoveryTime = 0;
let pendingExitAutoPip = false;
let lastPipMouseMoveCheck = 0;

/**
 * Checks whether the current browser environment supports the MediaSession API
 * action handler used by Chromium's native AutoPictureInPictureTabHelper.
 *
 * @returns {boolean}
 */
function hasMediaSessionPipSupport() {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.mediaSession &&
      typeof navigator.mediaSession.setActionHandler === "function"
  );
}

/**
 * Cancels any pending deferred Auto-PiP entry timer.
 *
 * @returns {void}
 */
function clearPipDeferredEnterTimer() {
  if (state._pipDeferredEnterTimer) {
    clearTimeout(state._pipDeferredEnterTimer);
    state._pipDeferredEnterTimer = null;
  }
}

/**
 * Throttled mousemove callback attached only while Picture-in-Picture is active.
 * Exits auto-PiP when the user returns to the tab and moves the pointer.
 *
 * @returns {void}
 */
function onPipMouseMove() {
  if (!document.pictureInPictureElement || state.pipManualTriggered) return;
  const now = Date.now();
  if (now - lastPipMouseMoveCheck > 500) {
    lastPipMouseMoveCheck = now;
    checkPipReturn();
  }
}

/**
 * Cancels any pending staggered forceExitYouTubePipState timers.
 *
 * @returns {void}
 */
function clearPipCleanupTimers() {
  if (Array.isArray(state._pipCleanupTimers) && state._pipCleanupTimers.length > 0) {
    for (const timerId of state._pipCleanupTimers) {
      clearTimeout(timerId);
    }
    state._pipCleanupTimers = [];
  }
}

/**
 * Runs forceExitYouTubePipState immediately and schedules deduplicated 50ms, 200ms, and 500ms passes.
 *
 * @returns {void}
 */
function scheduleExitPipStateCleanup() {
  clearPipCleanupTimers();
  forceExitYouTubePipState();
  state._pipCleanupTimers = [
    setTimeout(forceExitYouTubePipState, 50),
    setTimeout(forceExitYouTubePipState, 200),
    setTimeout(forceExitYouTubePipState, 500),
  ];
}

/**
 * Recovers a `<video>` element that became trapped in Blink's orphaned `:picture-in-picture`
 * User-Agent Shadow DOM interstitial state ("Playing in picture-in-picture") after the
 * browser's Picture-in-Picture window closed (`document.pictureInPictureElement === null`).
 *
 * In Blink C++ (`HTMLVideoElement::OnExitedPictureInPicture`), `picture_in_picture_interstitial_->Hide()`
 * is only invoked when `PictureInPictureControllerImpl` exits an active `picture_in_picture_element_`.
 * Cycling `requestPictureInPicture()` followed immediately by `document.exitPictureInPicture()`
 * re-binds `picture_in_picture_element_` and forces `OnExitedPictureInPicture()` to execute.
 *
 * @param {HTMLVideoElement} video
 * @returns {void}
 */
function recoverOrphanedBlinkPipState(video) {
  if (!video || document.pictureInPictureElement || pipToggling || autoPipToggling || recoveringOrphanedPip) return;
  const now = Date.now();
  if (lastOrphanedPipRecoveryTime && now - lastOrphanedPipRecoveryTime < 1500) return;
  recoveringOrphanedPip = true;
  lastOrphanedPipRecoveryTime = now;
  try {
    if (typeof video.requestPictureInPicture === "function") {
      const req = video.requestPictureInPicture();
      if (req && typeof req.then === "function") {
        req
          .then(() => {
            if (document.pictureInPictureElement) {
              return document.exitPictureInPicture();
            }
          })
          .catch(() => {})
          .finally(() => {
            recoveringOrphanedPip = false;
          });
        return;
      }
    }
  } catch (e) {}
  recoveringOrphanedPip = false;
}

/**
 * Interaction and activation callback for tab return across all browsers (Chrome, Helium, etc.).
 * When user returns to the tab and interacts with the page or focuses it, triggers auto-PiP
 * exit if PiP is currently active.
 *
 * When Auto-PiP was initiated by Chromium's browser-level `enterpictureinpicture` MediaSession
 * action (`state.pipEnteredViaMediaSession`), Chromium's `AutoPictureInPictureTabHelper` in the
 * browser process automatically closes the PiP window when the tab becomes visible. Deferring
 * our renderer-side `exitAutoPip()` fallback by 180ms prevents a `t = 0ms` Mojo IPC collision
 * between `document.exitPictureInPicture()` and `AutoPictureInPictureTabHelper::MaybeExitAutoPictureInPicture()`.
 *
 * @returns {void}
 */
function checkPipReturn() {
  clearPipDeferredEnterTimer();
  if (document.pictureInPictureElement && !state.pipManualTriggered) {
    if (state.pipEnteredViaMediaSession) {
      if (!state._pipDeferredExitTimer) {
        state._pipDeferredExitTimer = setTimeout(() => {
          state._pipDeferredExitTimer = null;
          state.pipEnteredViaMediaSession = false;
          if (document.pictureInPictureElement && !state.pipManualTriggered) {
            exitAutoPip();
          } else if (state.pipNeedsSurfaceRestore && document.visibilityState !== "hidden") {
            scheduleExitPipStateCleanup();
          }
        }, 180);
      }
      return;
    }

    const elapsed = Date.now() - (state.pipEnteredTime || 0);
    if (elapsed > 500) {
      if (state._pipDeferredExitTimer) {
        clearTimeout(state._pipDeferredExitTimer);
        state._pipDeferredExitTimer = null;
      }
      exitAutoPip();
    } else if (!state._pipDeferredExitTimer) {
      const remaining = Math.max(50, 520 - Math.max(0, elapsed));
      state._pipDeferredExitTimer = setTimeout(() => {
        state._pipDeferredExitTimer = null;
        if (document.pictureInPictureElement && !state.pipManualTriggered) {
          exitAutoPip();
        } else if (state.pipNeedsSurfaceRestore && document.visibilityState !== "hidden") {
          scheduleExitPipStateCleanup();
        }
      }, remaining);
    }
  } else if (state.pipNeedsSurfaceRestore && document.visibilityState !== "hidden") {
    scheduleExitPipStateCleanup();
  }
}

/**
 * Initializes Picture-in-Picture event listeners on document and window.
 * Attaches keyboard shortcut listener (Alt+P), visibility/blur listeners for auto-PiP,
 * and capturing lifecycle listeners to keep state synchronized across worlds.
 *
 * @returns {void}
 */
function setupPictureInPicture() {
  if (pipInitialized) {
    const shouldAuto = Boolean(state.settings.pipEnabled && state.settings.pipAutoOnTabSwitch);
    syncMediaSessionPipHandler(shouldAuto);
    return;
  }
  pipInitialized = true;

  const shouldAuto = Boolean(state.settings.pipEnabled && state.settings.pipAutoOnTabSwitch);
  syncMediaSessionPipHandler(shouldAuto);

  // Keyboard shortcut: Alt + P (case-insensitive, capture phase)
  document.addEventListener("keydown", onPipKeyDown, true);

  // Tab switch visibility listener
  document.addEventListener("visibilitychange", onPipVisibilityChange);

  // Window blur/focus listeners (complement visibilitychange for tab/window switches)
  window.addEventListener("blur", onPipWindowBlur);
  window.addEventListener("focus", onPipWindowFocus);

  // Helium / custom shell activation and user interaction listeners
  window.addEventListener("pageshow", checkPipReturn);
  document.addEventListener("focusin", checkPipReturn, true);
  document.addEventListener("pointerdown", checkPipReturn, true);

  // Leave and enter PiP events.
  // Note: HTML5 picture-in-picture events do not bubble from HTMLVideoElement,
  // so listening on document requires { capture: true }.
  document.addEventListener("leavepictureinpicture", onLeavePictureInPicture, true);
  document.addEventListener("enterpictureinpicture", onEnterPictureInPicture, true);

  // Ensure any newly mounted or resumed video element receives PiP attributes immediately
  document.addEventListener("play", (e) => {
    const target = /** @type {HTMLVideoElement | null} */ (e.target);
    if (target && target.tagName === "VIDEO") {
      bindPipVideo(target);
    }
  }, true);
}

/**
 * Keyboard listener for Alt + P shortcut.
 * Toggles native Picture-in-Picture mode for the active video.
 *
 * @param {KeyboardEvent} e - Keydown event
 * @returns {void}
 */
function onPipKeyDown(e) {
  if (!state.settings.pipEnabled) return;
  if (e.repeat) return; // Ignore key repeat to prevent re-entrant concurrency races

  // Case-insensitive match for Alt + P without Ctrl/Meta modifier or IME composition
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && (e.key === "p" || e.key === "P" || e.code === "KeyP")) {
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    togglePictureInPicture();
  }
}

/**
 * Toggles native Picture-in-Picture mode for the active YouTube video.
 * If PiP is currently active, exits PiP.
 * Otherwise, requests PiP on the active HTML5 video element.
 *
 * @returns {Promise<void>}
 */
async function togglePictureInPicture() {
  if (!state.settings.pipEnabled) return;
  if (pipToggling || autoPipToggling) return;
  if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) {
    console.log("[YT Adjust] Picture-in-Picture is disabled or unsupported in this document");
    return;
  }

  pipToggling = true;
  try {
    if (document.pictureInPictureElement) {
      state.pipAutoTriggered = false;
      state.pipManualTriggered = false;
      state.pipExitedTime = Date.now();
      state.pipNeedsSurfaceRestore = true;
      await document.exitPictureInPicture();
      console.log("[YT Adjust] Exited Picture-in-Picture");
      scheduleExitPipStateCleanup();
    } else {
      const video = getVideo();
      if (!video) {
        console.log("[YT Adjust] No active video element found for Picture-in-Picture");
        return;
      }
      state.pipManualTriggered = true;
      state.pipAutoTriggered = false;
      state.pipNeedsSurfaceRestore = true;
      bindPipVideo(video);
      await video.requestPictureInPicture();
      console.log("[YT Adjust] Entered Picture-in-Picture");
    }
  } catch (err) {
    console.log("[YT Adjust] Picture-in-Picture toggle failed:", err);
  } finally {
    pipToggling = false;
    if (pendingExitAutoPip) {
      pendingExitAutoPip = false;
      exitAutoPip();
    }
  }
}

/**
 * Registers or unregisters the browser-level 'enterpictureinpicture' media session action handler.
 * This hooks directly into Chromium's browser-initiated automatic Picture-in-Picture pipeline,
 * allowing PiP to activate when switching tabs without being blocked by transient user activation policies.
 *
 * @param {boolean} enable
 * @returns {void}
 */
function syncMediaSessionPipHandler(enable) {
  if (typeof navigator === "undefined" || !navigator.mediaSession || typeof navigator.mediaSession.setActionHandler !== "function") {
    return;
  }
  try {
    const actionName = /** @type {any} */ ("enterpictureinpicture");
    if (enable) {
      navigator.mediaSession.setActionHandler(actionName, async () => {
        if (!state.settings.pipEnabled || !state.settings.pipAutoOnTabSwitch) return;
        if (document.pictureInPictureElement) return;
        if (pipToggling || autoPipToggling) return;
        if (state.pipExitedTime && Date.now() - state.pipExitedTime < 800) return;
        if (isAdPlaying()) return;
        const video = getVideo();
        if (video && !video.paused && !video.ended) {
          clearPipDeferredEnterTimer();
          autoPipToggling = true;
          state.pipAutoTriggered = true;
          state.pipManualTriggered = false;
          state.pipEnteredViaMediaSession = true;
          state.pipNeedsSurfaceRestore = true;
          try {
            bindPipVideo(video);
            await video.requestPictureInPicture();
            state.pipEnteredTime = Date.now();
            console.log("[YT Adjust] Auto-PiP activated via mediaSession");
          } catch (err) {
            state.pipAutoTriggered = false;
            state.pipEnteredViaMediaSession = false;
            console.log("[YT Adjust] Auto-PiP mediaSession activation failed:", err);
          } finally {
            autoPipToggling = false;
            if (pendingExitAutoPip) {
              pendingExitAutoPip = false;
              exitAutoPip();
            }
          }
        }
      });
    } else {
      navigator.mediaSession.setActionHandler(actionName, null);
    }
  } catch (e) {
    // Action may not be supported on older browser engines
  }
}

/**
 * Automatically activates Picture-in-Picture when navigating away from the YouTube tab.
 * Requires active playback (!video.paused && !video.ended && (readyState >= 2 || (currentTime > 0 && readyState >= 1))).
 *
 * @returns {Promise<void>}
 */
async function triggerAutoPip() {
  clearPipDeferredEnterTimer();
  if (!state.settings.pipEnabled || !state.settings.pipAutoOnTabSwitch) return;
  if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) return;
  if (document.pictureInPictureElement) return;
  if (pipToggling || autoPipToggling) return;
  if (state.pipManualTriggered) return;
  if (isAdPlaying()) return;

  const video = getVideo();
  const isPlaying = video && !video.paused && !video.ended;
  const hasData = video && (
    (typeof video.readyState === "number" && video.readyState >= 2) ||
    (typeof video.currentTime === "number" && video.currentTime > 0 && video.readyState >= 1)
  );

  if (isPlaying && hasData) {
    autoPipToggling = true;
    state.pipAutoTriggered = true;
    state.pipManualTriggered = false;
    state.pipEnteredViaMediaSession = false;
    state.pipNeedsSurfaceRestore = true;
    try {
      bindPipVideo(video);
      await video.requestPictureInPicture();
      state.pipEnteredTime = Date.now();
      console.log("[YT Adjust] Auto-PiP activated on tab switch");
    } catch (err) {
      state.pipAutoTriggered = false;
      console.log("[YT Adjust] Auto-PiP activation failed:", err);
    } finally {
      autoPipToggling = false;
      if (pendingExitAutoPip) {
        pendingExitAutoPip = false;
        exitAutoPip();
      }
    }
  }
}

/**
 * Automatically exits Picture-in-Picture if it was previously auto-triggered on tab switch.
 * Preserves manual PiP if user explicitly engaged PiP via keyboard shortcut (Alt+P).
 * Synchronously checks and acquires a mutex guard to avoid concurrent exitPictureInPicture calls,
 * which causes Chromium's PiP pipeline to deadlock.
 *
 * @returns {Promise<void>}
 */
async function exitAutoPip() {
  // If user intentionally entered PiP via Alt+P, preserve it across tab switches
  if (state.pipManualTriggered) return;
  clearPipDeferredEnterTimer();
  if (state._pipDeferredExitTimer) {
    clearTimeout(state._pipDeferredExitTimer);
    state._pipDeferredExitTimer = null;
  }
  // If requestPictureInPicture is in-flight, mark pending exit so it runs on completion
  if (pipToggling || autoPipToggling) {
    pendingExitAutoPip = true;
    return;
  }
  if (!document.pictureInPictureElement) {
    state.pipEnteredViaMediaSession = false;
    if (state.pipNeedsSurfaceRestore) {
      scheduleExitPipStateCleanup();
    }
    return;
  }

  autoPipToggling = true;
  state.pipExitedTime = Date.now();
  state.pipNeedsSurfaceRestore = true;
  state.pipEnteredViaMediaSession = false;
  try {
    state.pipAutoTriggered = false;
    await document.exitPictureInPicture();
    state.pipExitedTime = Date.now();
    console.log("[YT Adjust] Auto-PiP exited on tab return");
    scheduleExitPipStateCleanup();
  } catch (err) {
    console.log("[YT Adjust] Auto-PiP exit failed:", err);
    scheduleExitPipStateCleanup();
  } finally {
    autoPipToggling = false;
    if (pendingExitAutoPip) {
      pendingExitAutoPip = false;
      exitAutoPip();
    }
  }
  state.pipAutoTriggered = false;
}

/**
 * Cleanly clears YouTube's internal Picture-in-Picture UI state and Blink's UA shadow DOM
 * Picture-in-Picture interstitial ("Playing in picture-in-picture") upon exiting PiP.
 *
 * This function:
 * 1. Retries exitPictureInPicture if auto-PiP remained stuck in Blink on a visible tab
 * 2. Removes any lingering pip-related CSS classes from #movie_player
 * 3. Detects and recovers from Blink's orphaned `:picture-in-picture` interstitial state
 * 4. Dispatches a resize event and calls YouTube's player methods to recalculate the viewport
 *
 * @returns {void}
 */
function forceExitYouTubePipState() {
  if (document.pictureInPictureElement) {
    // If the user returned to the visible tab and an earlier exitPictureInPicture call raced
    // with Chromium's native AutoPictureInPictureTabHelper, force Blink to exit PiP now.
    if (
      !state.pipManualTriggered &&
      !state.pipEnteredViaMediaSession &&
      document.visibilityState === "visible" &&
      !pipToggling &&
      !autoPipToggling
    ) {
      try {
        const p = document.exitPictureInPicture();
        if (p && typeof p.catch === "function") {
          p.catch(() => {});
        }
      } catch (e) {}
    }
    return;
  }

  const moviePlayer = getPlayer();
  const video = getVideo();

  // 1. Remove all pip-related CSS classes from #movie_player
  if (moviePlayer) {
    if (moviePlayer.classList && typeof moviePlayer.classList[Symbol.iterator] === "function") {
      const classesToRemove = [];
      for (const cls of moviePlayer.classList) {
        if (typeof cls === "string" && cls.toLowerCase().includes("pip")) {
          classesToRemove.push(cls);
        }
      }
      if (classesToRemove.length > 0 && typeof moviePlayer.classList.remove === "function") {
        moviePlayer.classList.remove(...classesToRemove);
      }
    } else if (typeof moviePlayer.className === "string" && moviePlayer.className.toLowerCase().includes("pip")) {
      moviePlayer.className = moviePlayer.className
        .split(/\s+/)
        .filter((c) => !c.toLowerCase().includes("pip"))
        .join(" ");
    }
  }

  // 2. Force Blink's HTMLVideoElement out of the "Playing in picture-in-picture" UA interstitial
  // and re-attach WebMediaPlayerImpl's inline compositor surface (DisplayType::kInline)
  if (video) {
    let isOrphanedBlinkPip = false;
    try {
      if (typeof video.matches === "function") {
        isOrphanedBlinkPip = video.matches(":picture-in-picture");
      }
    } catch (e) {}

    if (isOrphanedBlinkPip && document.visibilityState !== "hidden") {
      recoverOrphanedBlinkPipState(video);
    }

    if (state.pipNeedsSurfaceRestore && document.visibilityState !== "hidden") {
      state.pipNeedsSurfaceRestore = false;
      bindPipVideo(video);
    }

    video.style.opacity = "1";
    video.style.visibility = "visible";
    if (!state.miniPlayerActive) {
      video.style.position = "";
    }
    // Force layout / compositor reflow for video quad surface
    void video.offsetHeight;
  }

  if (!moviePlayer) return;

  // 3. Dispatch resize event to trigger YouTube's player recalculation without resetting mini-player video styles
  isInternalResizeDispatch = true;
  try {
    window.dispatchEvent(new Event("resize"));
  } catch (e) {
  } finally {
    isInternalResizeDispatch = false;
  }

  // 4. Call YouTube player methods to recalculate viewport and wake up controls
  const anyPlayer = /** @type {any} */ (moviePlayer);
  if (typeof anyPlayer.setInternalSize === "function") {
    try { anyPlayer.setInternalSize(); } catch (e) {}
  }
  if (typeof anyPlayer.wakeUpControls === "function") {
    try { anyPlayer.wakeUpControls(); } catch (e) {}
  }
  if (!state.miniPlayerActive && typeof anyPlayer.setSizeStyle === "function") {
    try { anyPlayer.setSizeStyle(false, false); } catch (e) {}
  }
}

/**
 * Handles visibility changes on document to automatically trigger or exit PiP.
 *
 * When MediaSession PiP is supported in Chromium/Helium, defers `triggerAutoPip()` on tab
 * hide by 80ms so `AutoPictureInPictureTabHelper` (`enterpictureinpicture` MediaSession action)
 * enters Auto-PiP cleanly without a competing `requestPictureInPicture()` call.
 * On tab return (`visible`), if Auto-PiP was entered via `AutoPictureInPictureTabHelper`,
 * lets Chromium's browser process close the PiP window undisturbed first (`checkPipReturn()`),
 * avoiding the `t = 0ms` Mojo session teardown race that leaves `"Playing in picture-in-picture"` stuck.
 *
 * @returns {void}
 */
function onPipVisibilityChange() {
  if (document.visibilityState === "hidden" || document.hidden) {
    if (state._pipDeferredExitTimer) {
      clearTimeout(state._pipDeferredExitTimer);
      state._pipDeferredExitTimer = null;
    }
    if (hasMediaSessionPipSupport()) {
      clearPipDeferredEnterTimer();
      state._pipDeferredEnterTimer = setTimeout(() => {
        state._pipDeferredEnterTimer = null;
        if (document.visibilityState === "hidden" || document.hidden) {
          triggerAutoPip();
        }
      }, 80);
    } else {
      triggerAutoPip();
    }
  } else if (document.visibilityState === "visible") {
    clearPipDeferredEnterTimer();
    state.pipExitedTime = Date.now();
    if (state.pipEnteredViaMediaSession) {
      checkPipReturn();
    } else {
      exitAutoPip();
      if (!document.pictureInPictureElement && state.pipNeedsSurfaceRestore) {
        scheduleExitPipStateCleanup();
      }
    }
  }
}

/**
 * Handles window blur event. Triggers auto-PiP when window loses focus.
 * Ignores transient blur events fired within 800ms of exiting PiP when the OS
 * destroys the floating PiP window upon returning to the tab.
 *
 * @returns {void}
 */
function onPipWindowBlur() {
  if (!state.settings.pipEnabled || !state.settings.pipAutoOnTabSwitch) return;
  if (state.pipExitedTime && Date.now() - state.pipExitedTime < 800) return;
  if (hasMediaSessionPipSupport()) {
    // When switching tabs inside Chrome/Helium, window.blur fires at t = 0ms before
    // visibilitychange and before AutoPictureInPictureTabHelper's MediaSession callback.
    // Defer by 100ms and only trigger if the document actually became hidden or lost OS focus.
    clearPipDeferredEnterTimer();
    state._pipDeferredEnterTimer = setTimeout(() => {
      state._pipDeferredEnterTimer = null;
      if (document.visibilityState === "hidden" || document.hidden) {
        triggerAutoPip();
      }
    }, 100);
    return;
  }
  triggerAutoPip();
}

/**
 * Handles window focus event. Exits auto-PiP if tab is focused again.
 *
 * @returns {void}
 */
function onPipWindowFocus() {
  clearPipDeferredEnterTimer();
  checkPipReturn();
}

/**
 * Handles entry into Picture-in-Picture mode.
 * Synchronizes manual vs automatic trigger state and cleans up floating mini-player.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onEnterPictureInPicture(e) {
  clearPipDeferredEnterTimer();
  clearPipCleanupTimers();
  state.pipNeedsSurfaceRestore = true;
  state.pipExitedTime = 0;
  if (!state.pipManualTriggered) {
    state.pipAutoTriggered = true;
    state.pipEnteredTime = Date.now();
    document.addEventListener("mousemove", onPipMouseMove, { passive: true, capture: true });
  }
  // If in-page floating mini-player was active, deactivate it to prevent duplicate player frames
  if (state.miniPlayerActive) {
    deactivateMiniPlayer();
  }
}

/**
 * Clears auto-triggered and manual flags when PiP window is dismissed or closed by user.
 * Restores in-page mini-player if user remains scrolled down past comment threshold.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onLeavePictureInPicture(e) {
  document.removeEventListener("mousemove", onPipMouseMove, true);
  clearPipDeferredEnterTimer();
  if (state._pipDeferredExitTimer) {
    clearTimeout(state._pipDeferredExitTimer);
    state._pipDeferredExitTimer = null;
  }
  state.pipAutoTriggered = false;
  state.pipManualTriggered = false;
  state.pipEnteredViaMediaSession = false;
  state.pipEnteredTime = 0;
  state.pipExitedTime = Date.now();
  state.pipNeedsSurfaceRestore = true;
  pendingExitAutoPip = false;

  scheduleExitPipStateCleanup();

  if (state.settings.miniPlayerEnabled && location.pathname === "/watch") {
    onMiniPlayerScroll();
  }
}

/**
 * Binds video element with Picture-in-Picture listeners and properties.
 * When Chromium's MediaSession Auto-PiP handler is available, avoids setting the HTML
 * `autopictureinpicture` attribute on `<video>` so Blink C++'s legacy renderer-side
 * `PictureInPictureControllerImpl::PageVisibilityChanged()` does not collide with
 * browser-level `AutoPictureInPictureTabHelper`.
 *
 * @param {HTMLVideoElement | null} video
 * @returns {void}
 */
function bindPipVideo(video) {
  if (!video) return;

  const shouldAuto = Boolean(state.settings.pipEnabled && state.settings.pipAutoOnTabSwitch);
  syncMediaSessionPipHandler(shouldAuto);

  if (hasMediaSessionPipSupport()) {
    try {
      video.removeAttribute("autopictureinpicture");
    } catch (e) {}
    try {
      Object.defineProperty(video, "autoPictureInPicture", {
        value: shouldAuto,
        writable: true,
        configurable: true,
      });
    } catch (e) {}
  } else {
    if ("autoPictureInPicture" in video) {
      try {
        video.autoPictureInPicture = shouldAuto;
      } catch (e) {
        // Safe fallback in restricted environments
      }
    }
    try {
      if (shouldAuto) {
        video.setAttribute("autopictureinpicture", "");
      } else {
        video.removeAttribute("autopictureinpicture");
      }
    } catch (e) {}
  }

  if ("disablePictureInPicture" in video && video.disablePictureInPicture) {
    try {
      video.disablePictureInPicture = false;
      video.removeAttribute("disablepictureinpicture");
    } catch (e) {}
  }

  if (typeof video.addEventListener === "function" && !video.dataset.ytAdjustPipBound) {
    video.dataset.ytAdjustPipBound = "true";
    video.addEventListener("leavepictureinpicture", onLeavePictureInPicture);
    video.addEventListener("enterpictureinpicture", onEnterPictureInPicture);
  }
}

// =============================================================================
// 8. CROSS-TAB PLAYBACK SYNC (Pause Other Tabs)
// =============================================================================

const TAB_INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
let multiTabSyncInitialized = false;
/** @type {BroadcastChannel | null} */
let tabSyncChannel = null;
let lastTabPlayBroadcastTime = 0;

/**
 * Initializes cross-tab playback coordination so starting a video in one YouTube tab
 * automatically pauses actively playing videos in other YouTube tabs when enabled.
 *
 * @returns {void}
 */
function setupMultiTabSync() {
  if (multiTabSyncInitialized) return;
  multiTabSyncInitialized = true;

  if (typeof BroadcastChannel === "function") {
    try {
      tabSyncChannel = new BroadcastChannel("yt-adjust-tab-sync");
      tabSyncChannel.addEventListener("message", (event) => {
        if (!state.settings.pauseOtherTabsEnabled) return;
        const data = event && event.data;
        if (!data || typeof data !== "object") return;
        if (data.type === "PAUSE_OTHER_TABS" && data.tabId && data.tabId !== TAB_INSTANCE_ID) {
          pausePlaybackFromOtherTab();
        }
      });
    } catch (e) {
      tabSyncChannel = null;
    }
  }

  // Secondary same-origin cross-tab channel via window.onstorage
  window.addEventListener("storage", (event) => {
    if (!state.settings.pauseOtherTabsEnabled) return;
    if (!event || event.key !== "yt_adjust_active_tab_play" || !event.newValue) return;
    try {
      const parsed = JSON.parse(event.newValue);
      if (parsed && typeof parsed === "object" && parsed.tabId && parsed.tabId !== TAB_INSTANCE_ID) {
        pausePlaybackFromOtherTab();
      }
    } catch (e) {}
  });

  document.addEventListener("play", onDocumentVideoPlay, true);
  document.addEventListener("playing", onDocumentVideoPlay, true);
  document.addEventListener("timeupdate", onDocumentVideoTimeUpdate, true);
  document.addEventListener("pause", onDocumentVideoPauseOrEnded, true);
  document.addEventListener("ended", onDocumentVideoPauseOrEnded, true);
}

/**
 * Evaluates whether a `<video>` element is an inline hover preview rather than the main player.
 *
 * @param {HTMLVideoElement} target
 * @returns {boolean}
 */
function isInlinePreviewVideo(target) {
  return Boolean(
    typeof target.closest === "function" &&
      target.closest("ytd-video-preview, #inline-preview-player, ytd-MovingThumbnailRenderer")
  );
}

/**
 * Resets playback announcement tracking when the active video pauses or finishes,
 * so subsequently clicking Play on this tab will re-announce playback and pause other tabs.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onDocumentVideoPauseOrEnded(e) {
  const target = /** @type {HTMLVideoElement | null} */ (e && e.target ? e.target : getVideo());
  if (!target || target.tagName !== "VIDEO") return;
  if (isInlinePreviewVideo(target)) return;
  state._hasAnnouncedCurrentPlayback = false;
  lastTabPlayBroadcastTime = 0;
}

/**
 * Fallback listener on `timeupdate` (capture phase) that catches videos whose initial
 * `play` and `playing` events fired before `document_idle` content script injection or
 * before asynchronous `SETTINGS_UPDATE` hydration completed.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onDocumentVideoTimeUpdate(e) {
  if (!state.settings.pauseOtherTabsEnabled) return;
  if (state._hasAnnouncedCurrentPlayback) return;
  if (state._lastPausedByOtherTabTime && Date.now() - state._lastPausedByOtherTabTime < 600) return;

  const target = /** @type {HTMLVideoElement | null} */ (e && e.target ? e.target : getVideo());
  if (!target || target.tagName !== "VIDEO") return;
  if (target.paused || target.ended) return;
  if (isInlinePreviewVideo(target)) return;

  if (document.visibilityState !== "hidden" || state._pendingPlayAnnouncement) {
    state._hasAnnouncedCurrentPlayback = true;
    state._pendingPlayAnnouncement = false;
    notifyTabPlaybackStarted();
  }
}

/**
 * Detects when a primary YouTube video begins playback in this tab and notifies
 * other open YouTube tabs to pause when pauseOtherTabsEnabled is active.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onDocumentVideoPlay(e) {
  const target = /** @type {HTMLVideoElement | null} */ (e && e.target ? e.target : getVideo());
  if (!target || target.tagName !== "VIDEO") return;
  if (target.paused || target.ended) return;
  if (isInlinePreviewVideo(target)) return;

  // If this tab is currently hidden in the background and was paused by another tab within the last 600ms,
  // prevent YouTube's internal buffer state from auto-resuming playback in the background.
  if (
    state.settings.pauseOtherTabsEnabled &&
    (document.visibilityState === "hidden" || document.hidden) &&
    state._lastPausedByOtherTabTime &&
    Date.now() - state._lastPausedByOtherTabTime < 600
  ) {
    try {
      target.pause();
    } catch (err) {}
    return;
  }

  if (!state.settings.pauseOtherTabsEnabled) {
    // Record that playback started in this tab so if SETTINGS_UPDATE arrives asynchronously
    // a few milliseconds later on a newly opened tab, handleSettingsUpdate will broadcast it immediately.
    state._pendingPlayAnnouncement = true;
    return;
  }

  state._hasAnnouncedCurrentPlayback = true;
  state._pendingPlayAnnouncement = false;
  notifyTabPlaybackStarted();
}

/**
 * Broadcasts to all other open YouTube tabs that this tab has started active video playback.
 * Uses BroadcastChannel, localStorage storage events, chrome.storage.local, and chrome.runtime relay.
 *
 * @returns {void}
 */
function notifyTabPlaybackStarted() {
  if (!state.settings.pauseOtherTabsEnabled) return;
  const now = Date.now();
  if (now - lastTabPlayBroadcastTime < 100) return;
  lastTabPlayBroadcastTime = now;

  if (tabSyncChannel) {
    try {
      tabSyncChannel.postMessage({
        type: "PAUSE_OTHER_TABS",
        tabId: TAB_INSTANCE_ID,
        timestamp: now,
      });
    } catch (e) {}
  }

  try {
    if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
      localStorage.setItem(
        "yt_adjust_active_tab_play",
        JSON.stringify({
          tabId: TAB_INSTANCE_ID,
          timestamp: now,
        })
      );
    }
  } catch (e) {}

  sendToIsolated("TAB_PLAYBACK_STARTED", {
    tabId: TAB_INSTANCE_ID,
    timestamp: now,
  });
}

/**
 * Pauses the active YouTube video in this tab when another YouTube tab begins playing.
 * Also exits Auto-PiP if this tab had floated into Picture-in-Picture on tab switch.
 *
 * @returns {void}
 */
function pausePlaybackFromOtherTab() {
  if (!state.settings.pauseOtherTabsEnabled) return;

  state._lastPausedByOtherTabTime = Date.now();
  state._hasAnnouncedCurrentPlayback = false;
  state._pendingPlayAnnouncement = false;

  const video = getVideo();
  const player = getPlayer();
  let pausedAny = false;

  if (video && !video.paused) {
    try {
      video.pause();
      pausedAny = true;
    } catch (e) {}
  }

  try {
    const allVideos = document.querySelectorAll("video");
    if (allVideos && typeof allVideos.length === "number") {
      for (let i = 0; i < allVideos.length; i++) {
        const v = /** @type {HTMLVideoElement} */ (allVideos[i]);
        if (v && !v.paused) {
          v.pause();
          pausedAny = true;
        }
      }
    }
  } catch (e) {}

  if (player && typeof player.pauseVideo === "function") {
    try {
      const playerState =
        typeof player.getPlayerState === "function" ? player.getPlayerState() : (pausedAny ? 1 : -1);
      if (playerState === 1 || playerState === 3 || pausedAny) {
        player.pauseVideo();
        pausedAny = true;
      }
    } catch (e) {}
  }

  // If this tab was in Auto-PiP mode (or entering Auto-PiP asynchronously), exit Auto-PiP
  // so a paused PiP window does not remain floating over the newly playing video in the other tab
  if (!state.pipManualTriggered && (document.pictureInPictureElement || state.pipAutoTriggered || autoPipToggling)) {
    exitAutoPip();
  }

  if (pausedAny) {
    console.log("[YT Adjust] Paused video because another YouTube tab started playing");
  }
}

// =============================================================================
// Message Handling
// =============================================================================

// Cross-world postMessage listener with origin verification and payload validation
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (!event.data || typeof event.data !== "object") return;
  if (event.data.source !== "yt-adjust-isolated") return;

  const { type, payload } = event.data;
  const safePayload = payload && typeof payload === "object" ? payload : {};

  switch (type) {
    case "SETTINGS_UPDATE":
      handleSettingsUpdate(safePayload);
      break;
    case "SEGMENTS_UPDATE":
      handleSegmentsUpdate(safePayload);
      break;
    case "PAUSE_FROM_OTHER_TAB":
      if (safePayload.tabId !== TAB_INSTANCE_ID) {
        pausePlaybackFromOtherTab();
      }
      break;
  }
});

/**
 * Applies updated configuration received from the isolated world.
 *
 * @param {Partial<ExtensionSettings>} settings - Updated settings object
 * @returns {void}
 */
function handleSettingsUpdate(settings) {
  if (!settings || typeof settings !== "object") return;

  const prev = { ...state.settings };
  state.settings = { ...state.settings, ...settings };

  // Quality changed
  if (settings.quality !== prev.quality || settings.qualityEnabled !== prev.qualityEnabled) {
    state.qualityRetryCount = 0;
    if (state.settings.qualityEnabled) {
      applyQuality();
    }
  }

  // SponsorBlock toggled
  if (settings.sponsorblockEnabled !== prev.sponsorblockEnabled) {
    if (state.settings.sponsorblockEnabled) {
      startSegmentMonitor();
      renderSeekbarOverlay();
    } else {
      stopSegmentMonitor();
      const overlay = document.getElementById("yt-adjust-seekbar-overlay");
      if (overlay) overlay.remove();
    }
  }

  // Volume gesture setup
  if (state.settings.volumeGestureEnabled) {
    setupVolumeGesture();
  }

  // Speed control toggled
  if (settings.speedControlEnabled !== prev.speedControlEnabled) {
    if (state.settings.speedControlEnabled) {
      injectSpeedButton();
    } else {
      const speedBtn = document.getElementById("yt-adjust-speed-btn");
      if (speedBtn) speedBtn.remove();
    }
  }

  // Volume boost toggled or boost level changed
  if (settings.volumeBoostEnabled !== prev.volumeBoostEnabled) {
    if (state.settings.volumeBoostEnabled) {
      setupVolumeBoost();
    } else {
      if (state.boostActive) {
        toggleBoost();
      }
      const boostBtn = document.getElementById("yt-adjust-boost-btn");
      if (boostBtn) boostBtn.remove();
    }
  }
  if (settings.volumeBoostLevel !== prev.volumeBoostLevel) {
    const activeGain = getBoostGain();
    const boostBtn = document.getElementById("yt-adjust-boost-btn");
    if (boostBtn) {
      boostBtn.setAttribute("aria-label", `Volume boost (${Math.round(activeGain * 100)}%)`);
    }
    if (state.boostActive && state.gainNode) {
      state.gainNode.gain.value = activeGain;
    }
  }

  // Mini-player toggled
  if (settings.miniPlayerEnabled !== prev.miniPlayerEnabled) {
    if (state.settings.miniPlayerEnabled) {
      setupMiniPlayer();
    } else {
      teardownMiniPlayer();
    }
  }

  // Picture-in-Picture settings changed
  if (settings.pipEnabled !== prev.pipEnabled || settings.pipAutoOnTabSwitch !== prev.pipAutoOnTabSwitch) {
    if (state.settings.pipEnabled) {
      setupPictureInPicture();
      bindPipVideo(getVideo());
      if (!state.settings.pipAutoOnTabSwitch && state.pipAutoTriggered && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        state.pipAutoTriggered = false;
        state.pipManualTriggered = false;
      }
    } else {
      syncMediaSessionPipHandler(false);
      const video = getVideo();
      if (video) {
        if ("autoPictureInPicture" in video) {
          try {
            video.autoPictureInPicture = false;
          } catch (e) {}
        }
        try {
          video.removeAttribute("autopictureinpicture");
        } catch (e) {}
      }
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        state.pipAutoTriggered = false;
        state.pipManualTriggered = false;
      }
    }
  }

  // Pause Other Tabs enabled or initial settings hydrated
  if (state.settings.pauseOtherTabsEnabled) {
    setupMultiTabSync();
    const video = getVideo();
    const isPlayingMainVideo = Boolean(video && !video.paused && !video.ended);
    if (
      isPlayingMainVideo &&
      (state._pendingPlayAnnouncement ||
        !state._hasAnnouncedCurrentPlayback ||
        (settings.pauseOtherTabsEnabled !== prev.pauseOtherTabsEnabled &&
          document.visibilityState === "visible" &&
          !document.hidden))
    ) {
      if (document.visibilityState !== "hidden" || state._pendingPlayAnnouncement) {
        state._hasAnnouncedCurrentPlayback = true;
        state._pendingPlayAnnouncement = false;
        notifyTabPlaybackStarted();
      }
    }
  } else {
    state._pendingPlayAnnouncement = false;
    state._hasAnnouncedCurrentPlayback = false;
  }
}

/**
 * Processes SponsorBlock segments received from the isolated world.
 *
 * @param {{ videoId?: string; segments?: SponsorBlockSegment[] }} data - Segment payload
 * @returns {void}
 */
function handleSegmentsUpdate(data) {
  if (!data || typeof data !== "object") return;
  if (location.pathname !== "/watch") return;

  // Guard against stale async segment responses from a previously navigated video
  const currentUrlVideoId = new URLSearchParams(location.search).get("v");
  if (currentUrlVideoId && typeof data.videoId === "string" && data.videoId !== currentUrlVideoId) {
    return;
  }

  state.currentVideoId = typeof data.videoId === "string" ? data.videoId : null;
  state.segments = Array.isArray(data.segments)
    ? data.segments.filter(
        /**
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
    : [];
  state.skippedSegments.clear();

  if (state.settings.sponsorblockEnabled && state.segments.length > 0) {
    startSegmentMonitor();
    watchForDuration();
  } else {
    stopSegmentMonitor();
    const overlay = document.getElementById("yt-adjust-seekbar-overlay");
    if (overlay) overlay.remove();
  }
}

// =============================================================================
// Initialization and SPA Navigation
// =============================================================================

/**
 * Re-applies preferred video quality when YouTube updates the player instance
 * (e.g. after pre-roll/mid-roll ad transitions or player re-hydration).
 *
 * @returns {void}
 */
function onYtPlayerUpdated() {
  if (location.pathname === "/watch" && state.settings.qualityEnabled && !isAdPlaying()) {
    state.qualityRetryCount = 0;
    applyQuality();
  }
}

/**
 * Re-applies preferred video quality when the primary HTML5 `<video>` element finishes
 * loading initial media data (`loadeddata` capture phase).
 *
 * @param {Event} e
 * @returns {void}
 */
function onDocumentVideoLoadedData(e) {
  const target = /** @type {HTMLVideoElement | null} */ (e && e.target ? e.target : null);
  if (!target || target.tagName !== "VIDEO" || isInlinePreviewVideo(target)) return;
  if (location.pathname === "/watch" && state.settings.qualityEnabled && !isAdPlaying()) {
    state.qualityRetryCount = 0;
    applyQuality();
  }
}

/**
 * Attaches a native `onStateChange` listener on `#movie_player` so preferred quality
 * is enforced immediately when a stream enters buffering (3), playing (1), or cued (5) state.
 *
 * @param {YouTubePlayerElement | null} player
 * @returns {void}
 */
function bindPlayerQualityStateChange(player) {
  if (!player || typeof player.addEventListener !== "function") return;
  if (player.dataset && player.dataset.ytAdjustQualityStateBound === "true") return;
  if (player.dataset) player.dataset.ytAdjustQualityStateBound = "true";
  player.addEventListener("onStateChange", (playerState) => {
    const code = typeof playerState === "number" ? playerState : Number(playerState);
    if ((code === 1 || code === 3 || code === 5) && location.pathname === "/watch" && state.settings.qualityEnabled && !isAdPlaying()) {
      applyQuality();
    }
  });
}

/**
 * Prefetches SponsorBlock segments as soon as YouTube begins a client-side SPA navigation
 * (`yt-navigate-start`), before DOM swap completes, so 0.0s intro segments are ready immediately.
 *
 * @param {any} e
 * @returns {void}
 */
function onNavigateStart(e) {
  try {
    const upcomingVideoId =
      e &&
      e.detail &&
      e.detail.endpoint &&
      e.detail.endpoint.watchEndpoint &&
      typeof e.detail.endpoint.watchEndpoint.videoId === "string"
        ? e.detail.endpoint.watchEndpoint.videoId
        : null;
    if (upcomingVideoId && upcomingVideoId !== state.currentVideoId) {
      sendToIsolated("PREFETCH_SEGMENTS", { videoId: upcomingVideoId });
    }
  } catch (_) {}
}

/**
 * Bootstraps the main world content script.
 * Registers yt-navigate-start, yt-navigate-finish, and initializes volume gesture listeners.
 *
 * @returns {void}
 */
function init() {
  document.addEventListener("yt-navigate-start", onNavigateStart);
  document.addEventListener("yt-navigate-finish", onNavigate);
  document.addEventListener("yt-player-updated", onYtPlayerUpdated, true);
  document.addEventListener("loadeddata", onDocumentVideoLoadedData, true);
  onNavigate();
  sendToIsolated("REQUEST_SETTINGS", {});
  setupVolumeGesture();
  setupPictureInPicture();
  setupMultiTabSync();
}

/**
 * Handles client-side YouTube SPA navigation events.
 * Cleans up previous video state and initializes features for the new video.
 *
 * @returns {void}
 */
function onNavigate() {
  _cachedYtdPlayer = null;
  _cachedVideo = null;
  dismissSkipToast(true);
  dismissPremiumModal();
  if (state.durationPollInterval) {
    clearInterval(state.durationPollInterval);
    state.durationPollInterval = null;
  }
  if (state.qualityRetryTimer) {
    clearTimeout(state.qualityRetryTimer);
    state.qualityRetryTimer = null;
  }
  if (state._navInitTimer) {
    clearTimeout(state._navInitTimer);
    state._navInitTimer = null;
  }

  // Always clear previous video's SponsorBlock segments and seekbar markers immediately on navigation
  stopSegmentMonitor();
  state.segments = [];
  state.skippedSegments.clear();
  const prevOverlay = document.getElementById("yt-adjust-seekbar-overlay");
  if (prevOverlay) prevOverlay.remove();

  if (location.pathname !== "/watch") {
    teardownMiniPlayer();
    if (state.pipAutoTriggered && document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      state.pipAutoTriggered = false;
      state.pipManualTriggered = false;
    }
    return;
  }

  state._lastNavTime = Date.now();
  state.qualityRetryCount = 0;
  state.miniPlayerDismissed = false;
  state._hasAnnouncedCurrentPlayback = false;
  state._pendingPlayAnnouncement = false;
  deactivateMiniPlayer();

  const player = getPlayer();
  bindPlayerQualityStateChange(player);
  if (state.settings.qualityEnabled) {
    if (player && typeof player.getAvailableQualityLevels === "function") {
      applyQuality();
    } else {
      state.qualityRetryTimer = setTimeout(applyQuality, 600);
    }
  }

  const videoId = new URLSearchParams(location.search).get("v");
  state.currentVideoId = videoId;
  if (videoId) {
    sendToIsolated("REQUEST_SEGMENTS", { videoId });
  }

  // Re-bind speed control and PiP to new video and re-apply custom speed immediately (unless live stream/ad)
  const video = getVideo();
  bindSpeedVideo(video);
  bindPipVideo(video);
  if (
    !isLiveStream() &&
    !isAdPlaying() &&
    state.customPlaybackRate &&
    Math.abs(state.customPlaybackRate - 1.0) >= 0.01
  ) {
    if (video) {
      video.defaultPlaybackRate = state.customPlaybackRate;
      video.playbackRate = state.customPlaybackRate;
    }
    updateSpeedButton(state.customPlaybackRate);
  } else {
    updateSpeedButton(video ? video.playbackRate : 1.0);
  }

  // Attempt immediate control injection if player bar is already mounted (common on SPA transitions)
  if (state.settings.speedControlEnabled) injectSpeedButton();
  if (state.settings.volumeBoostEnabled) setupVolumeBoost();
  setupMiniPlayer();
  setupPictureInPicture();

  // Follow-up pass after 600ms to catch late-hydrated controls on fresh page loads
  state._navInitTimer = setTimeout(() => {
    state._navInitTimer = null;
    if (state.settings.speedControlEnabled) injectSpeedButton();
    const v = getVideo();
    if (v) {
      bindSpeedVideo(v);
      bindPipVideo(v);
    }
    if (state.settings.volumeBoostEnabled) setupVolumeBoost();
    setupMiniPlayer();
    setupPictureInPicture();
  }, 600);
}

/**
 * Relays a message to content/isolated.js using postMessage.
 *
 * @param {string} type - Message type identifier
 * @param {Record<string, any>} payload - Message content
 * @returns {void}
 */
function sendToIsolated(type, payload) {
  window.postMessage(
    { source: "yt-adjust-main", type, payload: payload || {} },
    window.location.origin
  );
}

// Fire initialization
init();
console.log("[YT Adjust] Main world script loaded (v2.4.3)");
