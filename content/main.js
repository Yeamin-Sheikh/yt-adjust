// =============================================================================
// YT Adjust — Main World Content Script (v2.3.2)
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
// 3. DOM reparenting and stacking context escape:
//    When the mini-player activates, ytd-player is appended to document.body. This allows
//    the floating player to escape ancestor stacking contexts created by CSS transforms
//    or will-change rules on YouTube layout containers. An invisible placeholder element
//    preserves layout space to prevent page content jumps.
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
 * @property {number | null} skipAnimationFrame - Active rVFC or rAF callback handle
 * @property {any} durationPollInterval - Interval handle for seekbar overlay duration polling
 * @property {number} qualityRetryCount - Counter for quality automation retry attempts
 * @property {any} qualityRetryTimer - Timer handle for scheduled quality retry
 * @property {boolean} rightMouseDown - Tracks right mouse button depression
 * @property {boolean} scrolledWhileHeld - True if mouse wheel moved while right mouse button was down
 * @property {any} volumeOverlayTimer - Timer handle for fading out volume overlay
 * @property {any} speedOverlayTimer - Timer handle for fading out speed overlay
 * @property {number} customPlaybackRate - User-configured playback speed multiplier
 * @property {HTMLVideoElement | null} _speedBoundVideo - Active video element with attached rate listeners
 * @property {AudioContext | null} audioContext - Web Audio API context for volume amplification
 * @property {GainNode | null} gainNode - Gain node providing 150% volume boost
 * @property {MediaElementAudioSourceNode | null} mediaSource - Cached media element audio source
 * @property {boolean} boostActive - True when 150% audio boost is engaged
 * @property {boolean} miniPlayerActive - True when floating mini-player is in viewport
 * @property {boolean} miniPlayerDismissed - True if user manually closed mini-player for current video
 * @property {HTMLElement | null} miniPlayerPlaceholder - Spacer element preventing layout shifts
 * @property {HTMLElement | null} [_miniPlayerOriginalParent] - Original DOM parent of ytd-player
 * @property {Node | null} [_miniPlayerNextSibling] - Original next sibling of ytd-player for reinsertion
 * @property {HTMLElement | null} [_miniPlayerAnchor] - Container element preserving layout space during mini-player
 * @property {boolean} [_adSkipLogged] - Guard flag preventing console spam during ad playback
 * @property {boolean} pipAutoTriggered - True if Picture-in-Picture was automatically engaged on tab switch
 * @property {boolean} [_pipAutoInitiating] - Guard flag indicating auto-PiP is actively requesting PiP
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
    miniPlayerEnabled: true,
    pipEnabled: true,
    pipAutoOnTabSwitch: false,
  },

  // SponsorBlock
  segments: [],
  currentVideoId: null,
  skippedSegments: new Set(),
  skipAnimationFrame: null,
  durationPollInterval: null,

  // Quality
  qualityRetryCount: 0,
  qualityRetryTimer: null,

  // Volume gesture
  rightMouseDown: false,
  scrolledWhileHeld: false,
  volumeOverlayTimer: null,

  // Speed control
  speedOverlayTimer: null,
  customPlaybackRate: 1.0,
  _speedBoundVideo: /** @type {HTMLVideoElement | null} */ (null),

  // Volume boost (Web Audio API)
  audioContext: null,
  gainNode: null,
  mediaSource: null,   // createMediaElementSource() can only be called ONCE per <video>
  boostActive: false,

  // Mini-player
  miniPlayerActive: false,
  miniPlayerDismissed: false, // user clicked close — don't re-show until next navigation
  miniPlayerPlaceholder: null,
  _miniPlayerOriginalParent: null,
  _miniPlayerNextSibling: null,
  _miniPlayerAnchor: null,
  _adSkipLogged: false,

  // Picture-in-Picture
  pipAutoTriggered: false,
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

// Maps our internal quality keys to the labels YouTube shows in its menu.
// YouTube's quality menu shows labels like "1080p HD", "720p", "480p", etc.
// We match by checking if the menu item label STARTS WITH the resolution text.
/** @type {Record<string, string>} */
const QUALITY_TO_LABEL = {
  highres: "2160p",  // 4K shows as 2160p in the menu
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

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------
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
 * We always query for the ancestor of #movie_player.
 *
 * @returns {HTMLElement | null}
 */
function getYtdPlayer() {
  const moviePlayer = getPlayer();
  if (!moviePlayer) return null;
  return /** @type {HTMLElement | null} */ (moviePlayer.closest("ytd-player"));
}

/**
 * Retrieves the active HTML5 video element within the YouTube player.
 * Cast to HTMLVideoElement to expose playback properties and frame callbacks.
 *
 * @returns {HTMLVideoElement | null}
 */
function getVideo() {
  const player = getPlayer();
  if (!player) {
    return /** @type {HTMLVideoElement | null} */ (
      document.querySelector("video.html5-main-video") || document.querySelector("video")
    );
  }
  return /** @type {HTMLVideoElement | null} */ (
    player.querySelector("video.html5-main-video") || player.querySelector("video") || document.querySelector("video")
  );
}

/**
 * Helper: waits for a condition function to return a truthy value.
 *
 * @param {() => any} conditionFn - Evaluator function
 * @param {number} [timeoutMs=3000] - Maximum duration in milliseconds
 * @param {number} [intervalMs=100] - Polling interval in milliseconds
 * @returns {Promise<any>}
 */
function waitFor(conditionFn, timeoutMs = 3000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const result = conditionFn();
      if (result) return resolve(result);
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(check, intervalMs);
    };
    check();
  });
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
// MODULE 1: Auto Quality (Settings Menu Automation)
// =============================================================================
// YouTube deprecated setPlaybackQualityRange() and setPlaybackQuality().
// They still exist as functions on movie_player but are no-ops in modern player builds.
// The only reliable way to force quality is to automate clicks through the settings gear menu.
//
// Fallback: we also persist yt-player-quality to localStorage so YouTube's
// bootstrap code reads our preference during player initialization.
// =============================================================================

/**
 * Applies the configured preferred video quality level.
 * Checks current playback quality first to avoid redundant menu interaction.
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

  const targetQuality = state.settings.quality;
  const targetLabel = QUALITY_TO_LABEL[targetQuality];
  if (!targetLabel) return;

  // Persist preference to localStorage for YouTube player bootstrap
  try {
    localStorage.setItem("yt-player-quality", JSON.stringify({
      data: targetQuality,
      creation: Date.now(),
      expiration: Date.now() + 2592000000,
    }));
  } catch (_) {}

  // Check current quality label if exposed by YouTube player
  if (typeof player.getPlaybackQualityLabel === "function") {
    const currentLabel = player.getPlaybackQualityLabel();
    if (currentLabel && currentLabel.startsWith(targetLabel)) {
      console.log(`[YT Adjust] Quality already at ${currentLabel}`);
      return;
    }
  }

  // Check video element dimensions as a secondary indicator
  const video = getVideo();
  if (video && targetQuality === "hd1080" && video.videoHeight >= 1080) {
    console.log(`[YT Adjust] Quality already 1080p (${video.videoWidth}x${video.videoHeight})`);
    return;
  }

  // Automate settings menu to select target quality
  try {
    await setQualityViaMenu(player, targetLabel);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log("[YT Adjust] Quality menu automation failed:", errorMsg);
    retryQuality();
  }
}

/**
 * Clicks through YouTube's settings menu to select a specific quality level.
 * Steps: settings gear → Quality item → target resolution → close menu
 *
 * @param {YouTubePlayerElement} player - YouTube player DOM element
 * @param {string} targetLabel - Target resolution label (e.g. "1080p")
 * @returns {Promise<void>}
 */
async function setQualityViaMenu(player, targetLabel) {
  const settingsBtn = /** @type {HTMLElement | null} */ (player.querySelector(".ytp-settings-button"));
  if (!settingsBtn) throw new Error("settings button not found");

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

  // Find the target quality option
  const qualityOptions = player.querySelectorAll(".ytp-menuitem");
  let targetOption = null;

  for (const opt of qualityOptions) {
    const label = opt.querySelector(".ytp-menuitem-label");
    if (!label || !label.textContent) continue;
    const text = label.textContent.trim();

    // Match: "1080p HD", "1080p Premium HD", "720p", etc.
    if (text.startsWith(targetLabel)) {
      targetOption = /** @type {HTMLElement} */ (opt);
      break;
    }
  }

  if (!targetOption) {
    // Target quality not available — find highest available below target
    const qualityOrder = ["2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"];
    const targetIndex = qualityOrder.indexOf(targetLabel);

    for (let i = targetIndex + 1; i < qualityOrder.length; i++) {
      for (const opt of qualityOptions) {
        const label = opt.querySelector(".ytp-menuitem-label");
        if (label && label.textContent && label.textContent.trim().startsWith(qualityOrder[i])) {
          targetOption = /** @type {HTMLElement} */ (opt);
          break;
        }
      }
      if (targetOption) break;
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
  if (!state.settings.sponsorblockEnabled || state.segments.length === 0) return;

  const video = getVideo();
  if (!video) return;

  function checkSegments() {
    if (!video || !video.isConnected) return; // video removed from DOM

    if (!video.paused && !video.seeking) {
      const currentTime = video.currentTime;

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
          video.currentTime = end;
          state.skippedSegments.add(uuid);

          const catLabel = CATEGORY_LABELS[segment.category] || segment.category;
          const dur = Math.round(end - start);
          console.log(`[YT Adjust] Skipped ${catLabel} (${dur}s): ${start.toFixed(1)}s → ${end.toFixed(1)}s`);

          if (state.settings.sponsorblockNotify) {
            showSkipToast(`${catLabel} skipped (${dur}s)`, start);
          }
          break;
        }
      }
    }

    // requestVideoFrameCallback synchronizes checks to decoded video frames
    if (typeof video.requestVideoFrameCallback === "function") {
      state.skipAnimationFrame = video.requestVideoFrameCallback(checkSegments);
    } else {
      state.skipAnimationFrame = requestAnimationFrame(checkSegments);
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
    const video = getVideo();
    if (video && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(state.skipAnimationFrame);
    } else {
      cancelAnimationFrame(state.skipAnimationFrame);
    }
    state.skipAnimationFrame = null;
  }
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

  const video = getVideo();
  if (!video || !video.duration || isNaN(video.duration)) return;

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

    const bar = document.createElement("div");
    Object.assign(bar.style, {
      position: "absolute",
      left: `${leftPercent}%`,
      width: `${widthPercent}%`,
      top: "-25%",
      height: "150%",
      backgroundColor: "#fff",
      opacity: "0.35",
      pointerEvents: "none",
      borderRadius: "1px",
      transition: "top 0.15s ease, height 0.15s ease, opacity 0.15s ease",
    });

    bar.dataset.category = segment.category;
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
        b.style.top = "-50%";
        b.style.height = "200%";
        b.style.opacity = "0.55";
      });
    });

    progressBarContainer.addEventListener("mouseleave", () => {
      const bars = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#yt-adjust-seekbar-overlay > div"));
      bars.forEach((b) => {
        b.style.top = "-25%";
        b.style.height = "150%";
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
 * Dismisses the active skip notification toast and tears down the undo keyboard listener.
 *
 * @returns {void}
 */
function dismissSkipToast() {
  if (undoKeyHandler) {
    document.removeEventListener("keydown", undoKeyHandler, true);
    undoKeyHandler = null;
  }
  if (toastDismissTimer) {
    clearTimeout(toastDismissTimer);
    toastDismissTimer = null;
  }
  const toast = document.getElementById("yt-adjust-toast");
  if (toast) {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  }
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
  dismissSkipToast();

  const toast = document.createElement("div");
  toast.id = "yt-adjust-toast";

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
        video.currentTime = undoTimestamp;
        console.log(`[YT Adjust] Undo skip — seeking to ${undoTimestamp.toFixed(1)}s`);
      }
      dismissSkipToast();
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
        video.currentTime = undoTimestamp;
        console.log(`[YT Adjust] Undo skip via Enter key — seeking to ${undoTimestamp.toFixed(1)}s`);
      }
      dismissSkipToast();
    };

    document.addEventListener("keydown", undoKeyHandler, true);
  }

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
    dismissSkipToast();
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

  // Wheel handler: handles Shift + scroll (speed) and right-click + scroll (volume)
  document.addEventListener("wheel", (e) => {
    if (!isInsidePlayer(e.target)) return;

    const targetElement = e.target instanceof Element ? e.target : null;
    const isOverSpeedBtn = targetElement && (
      targetElement.id === "yt-adjust-speed-btn" ||
      (typeof targetElement.closest === "function" && Boolean(targetElement.closest("#yt-adjust-speed-btn")))
    );

    // Speed control: Shift + scroll over player OR wheel directly over speed button
    if ((e.shiftKey && state.settings.speedControlEnabled) || isOverSpeedBtn) {
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
      bindSpeedVideo(video);
      video.playbackRate = newSpeed;

      showSpeedOverlay(newSpeed);
      updateSpeedButton(newSpeed);
      return;
    }

    // Volume control: Right-click held + wheel scroll
    if (!state.settings.volumeGestureEnabled) return;
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
 * Attaches playbackRate event listeners to the active video element.
 * Ensures the speed button stays in sync with native YouTube menu changes
 * and persists custom playback speed across video transitions.
 *
 * @param {HTMLVideoElement | null} video - The active video element
 * @returns {void}
 */
function bindSpeedVideo(video) {
  if (!video) return;
  if (state._speedBoundVideo === video) return;
  state._speedBoundVideo = video;

  // Apply custom speed if one was configured and not default 1x
  if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
    video.playbackRate = state.customPlaybackRate;
    updateSpeedButton(state.customPlaybackRate);
  } else {
    updateSpeedButton(video.playbackRate || 1.0);
  }

  // Handle video metadata loading (YouTube resets rate when loading new media stream)
  video.addEventListener("loadedmetadata", () => {
    if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
      video.playbackRate = state.customPlaybackRate;
      updateSpeedButton(state.customPlaybackRate);
    } else {
      updateSpeedButton(video.playbackRate || 1.0);
    }
  });

  // Handle play start
  video.addEventListener("play", () => {
    if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
      if (Math.abs(video.playbackRate - state.customPlaybackRate) >= 0.01) {
        video.playbackRate = state.customPlaybackRate;
      }
      updateSpeedButton(state.customPlaybackRate);
    }
  });

  // Bi-directional sync: if rate changes (e.g. from YouTube's native settings menu)
  video.addEventListener("ratechange", () => {
    const currentRate = video.playbackRate;
    if (state.customPlaybackRate && Math.abs(currentRate - state.customPlaybackRate) < 0.01) {
      updateSpeedButton(currentRate);
      return;
    }
    // Rate changed externally (e.g. user selected another speed from YouTube's gear menu)
    state.customPlaybackRate = currentRate;
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
    document.head.appendChild(style);
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
    if (video) {
      video.playbackRate = 1.0;
      showSpeedOverlay(1.0);
    }
    updateSpeedButton(1.0);
  });

  btn.addEventListener("wheel", (e) => {
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
    bindSpeedVideo(video);
    video.playbackRate = newSpeed;

    showSpeedOverlay(newSpeed);
    updateSpeedButton(newSpeed);
  }, { passive: false });

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
  btn.setAttribute("aria-label", "Volume boost (150%)");

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
    showVolumeOverlay(Math.round(video.volume * 100));
    console.log("[YT Adjust] Volume boost OFF");
  } else {
    ensureAudioPipeline(video);

    // Browser autoplay policy guard: resume AudioContext on user click if suspended
    if (state.audioContext && state.audioContext.state === "suspended") {
      state.audioContext.resume().catch((resumeErr) => {
        console.warn("[YT Adjust] AudioContext resume failed:", resumeErr);
      });
    }

    if (state.gainNode) state.gainNode.gain.value = BOOST_GAIN;
    state.boostActive = true;
    updateBoostButtonState(true);

    const player = getPlayer();
    const vol = player && typeof player.getVolume === "function"
      ? player.getVolume()
      : Math.round(video.volume * 100);
    showVolumeOverlay(Math.round(vol * BOOST_GAIN));
    console.log("[YT Adjust] Volume boost ON (150%)");
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
  if (state.audioContext && state.mediaSource) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("[YT Adjust] AudioContext not supported in this browser");
      return;
    }

    state.audioContext = new AudioContextClass();
    state.mediaSource = state.audioContext.createMediaElementSource(video);
    state.gainNode = state.audioContext.createGain();

    state.mediaSource.connect(state.gainNode);
    state.gainNode.connect(state.audioContext.destination);
    state.gainNode.gain.value = 1.0;

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
    #movie_player .html5-video-container {
      width: 100% !important;
      height: 100% !important;
    }
    #movie_player .html5-video-container video.html5-main-video {
      width: 100% !important;
      height: 100% !important;
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
  (document.head || document.documentElement).appendChild(style);
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
  if (!state.miniPlayerActive) return;
  const ytdPlayer = getYtdPlayer();
  if (!ytdPlayer) return;

  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const isStandard = Boolean(player && player.contains(ytdPlayer));
  const anchor = state._miniPlayerAnchor || (isStandard ? player : ytdPlayer.parentElement);
  if (!anchor) return;

  const video = getVideo();
  const aspectRatio = (video && video.videoWidth && video.videoHeight)
    ? (video.videoHeight / video.videoWidth)
    : (9 / 16);

  const containerWidth = anchor.clientWidth || anchor.offsetWidth;
  if (containerWidth > 0) {
    const newHeight = Math.round(containerWidth * aspectRatio);
    if (isStandard) {
      if (player) player.style.minHeight = `${newHeight}px`;
      const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
      if (playerOuter) playerOuter.style.minHeight = `${newHeight}px`;
    }
    if (ytdPlayer.parentElement) {
      ytdPlayer.parentElement.style.minHeight = `${newHeight}px`;
    }
    const placeholder = document.getElementById("yt-adjust-player-placeholder");
    if (placeholder) {
      placeholder.style.height = `${newHeight}px`;
    }
  }
}

/**
 * Attaches scroll and resize listeners for the mini-player trigger and layout adaptation.
 *
 * @returns {void}
 */
function setupMiniPlayer() {
  if (!state.settings.miniPlayerEnabled) return;
  ensureVideoContainerStyles();
  if (miniPlayerScrollBound) return;

  document.addEventListener("scroll", onMiniPlayerScroll, { passive: true });
  window.addEventListener("resize", onMiniPlayerWindowResize, { passive: true });
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
  const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
  const fullBleed = /** @type {HTMLElement | null} */ (
    document.querySelector("#full-bleed-container") ||
    document.querySelector("#player-theater-container")
  );

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

  // If we have an active cached anchor and it is still valid and visible, prioritize it
  if (state.miniPlayerActive && state._miniPlayerAnchor && isVisible(state._miniPlayerAnchor)) {
    return state._miniPlayerAnchor;
  }

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

  // Never activate mini-player during active fullscreen playback
  if (document.fullscreenElement) return;

  const ytdPlayer = getYtdPlayer();
  if (!ytdPlayer) return;

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

  // Measure player height accurately before applying fixed positioning
  const ytdRect = ytdPlayer.getBoundingClientRect();
  const playerRect = (isStandardPlayer && player) ? player.getBoundingClientRect() : null;
  const height = (playerRect && playerRect.height > 0)
    ? playerRect.height
    : (ytdRect.height > 0 ? ytdRect.height : (ytdPlayer.offsetHeight || 560));

  // Maintain minimum height on the exact flow container hierarchy:
  // In standard layout, preserve #player, #player-container-outer, and playerContainer.
  // In theater mode, NEVER touch #player (which sits empty in #primary) — only preserve playerContainer (#player-theater-container).
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
    const fullBleed = /** @type {HTMLElement | null} */ (
      document.querySelector("#full-bleed-container") ||
      document.querySelector("#player-theater-container")
    );
    if (fullBleed) {
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

  const moviePlayer = getPlayer();
  if (moviePlayer) {
    if (typeof moviePlayer.setAttribute === "function") {
      moviePlayer.setAttribute("data-yt-adjust-mini", "true");
    }
    Object.assign(moviePlayer.style, {
      width: "100%",
      height: "100%",
    });
    if (typeof moviePlayer.setInternalSize === "function") {
      moviePlayer.setInternalSize();
    }
  }

  // Ensure video container matches player bounds so video height is not 0px
  const container = /** @type {HTMLElement | null} */ (document.querySelector(".html5-video-container"));
  if (container) {
    Object.assign(container.style, {
      width: "100%",
      height: "100%",
    });
  }

  const video = getVideo();
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
 * Restores ytd-player in-place and clears mini-player inline styles.
 * Restores minHeight on layout containers (#player, #player-theater-container) and removes placeholder element.
 * Triggers layout recalculation so YouTube restores native video dimensions without black screen.
 *
 * @returns {void}
 */
function deactivateMiniPlayer() {
  if (!state.miniPlayerActive) return;

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
      playerContainer.style.minHeight = "";
      playerContainer.style.position = "";
      playerContainer.style.zIndex = "";
    }

    const player = /** @type {HTMLElement | null} */ (document.querySelector("#player"));
    if (player) {
      player.style.minHeight = "";
      player.style.position = "";
      player.style.zIndex = "";
    }

    const playerOuter = /** @type {HTMLElement | null} */ (document.querySelector("#player-container-outer"));
    if (playerOuter) {
      playerOuter.style.minHeight = "";
    }

    const fullBleed = /** @type {HTMLElement | null} */ (
      document.querySelector("#full-bleed-container") ||
      document.querySelector("#player-theater-container")
    );
    if (fullBleed) {
      fullBleed.style.position = "";
      fullBleed.style.zIndex = "";
      fullBleed.style.minHeight = "";
    }

    if (state._miniPlayerAnchor) {
      state._miniPlayerAnchor.style.minHeight = "";
      state._miniPlayerAnchor = null;
    }

    const placeholder = document.getElementById("yt-adjust-player-placeholder");
    if (placeholder) {
      placeholder.remove();
    }

    const container = /** @type {HTMLElement | null} */ (document.querySelector(".html5-video-container"));
    if (container) {
      container.style.width = "100%";
      container.style.height = "100%";
    }

    const moviePlayer = getPlayer();
    if (moviePlayer) {
      if (typeof moviePlayer.removeAttribute === "function") {
        moviePlayer.removeAttribute("data-yt-adjust-mini");
      }
      moviePlayer.style.width = "";
      moviePlayer.style.height = "";
    }

    const video = getVideo();
    if (video) {
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.left = "";
      video.style.top = "";
      video.style.objectFit = "contain";
    }

    // Notify YouTube to recalculate video dimensions and prevent black frame
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      try {
        const resizeEvt = typeof Event === "function" ? new Event("resize") : null;
        if (resizeEvt) window.dispatchEvent(resizeEvt);
      } catch (evtErr) {
        // Safe fallback in test environments
      }
    }
    if (moviePlayer && typeof moviePlayer.setInternalSize === "function") {
      moviePlayer.setInternalSize();
    }
  }

  const closeBtn = document.getElementById("yt-adjust-mp-close");
  if (closeBtn) closeBtn.remove();

  state.miniPlayerActive = false;
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
  if (pipToggling) return;
  if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) {
    console.log("[YT Adjust] Picture-in-Picture is disabled or unsupported in this document");
    return;
  }

  pipToggling = true;
  try {
    if (document.pictureInPictureElement) {
      state.pipAutoTriggered = false;
      await document.exitPictureInPicture();
      console.log("[YT Adjust] Exited Picture-in-Picture");
    } else {
      const video = getVideo();
      if (!video) {
        console.log("[YT Adjust] No active video element found for Picture-in-Picture");
        return;
      }
      state.pipAutoTriggered = false;
      bindPipVideo(video);
      await video.requestPictureInPicture();
      console.log("[YT Adjust] Entered Picture-in-Picture");
    }
  } catch (err) {
    console.log("[YT Adjust] Picture-in-Picture toggle failed:", err);
  } finally {
    pipToggling = false;
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
        const video = getVideo();
        if (video && !video.paused && !video.ended) {
          state.pipAutoTriggered = true;
          state._pipAutoInitiating = true;
          try {
            bindPipVideo(video);
            await video.requestPictureInPicture();
            console.log("[YT Adjust] Auto-PiP activated via mediaSession");
          } catch (err) {
            state.pipAutoTriggered = false;
            console.log("[YT Adjust] Auto-PiP mediaSession activation failed:", err);
          } finally {
            state._pipAutoInitiating = false;
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
  if (!state.settings.pipEnabled || !state.settings.pipAutoOnTabSwitch) return;
  if (!("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled) return;
  if (document.pictureInPictureElement) return;
  if (pipToggling || autoPipToggling) return;

  const video = getVideo();
  const isPlaying = video && !video.paused && !video.ended;
  const hasData = video && (
    (typeof video.readyState === "number" && video.readyState >= 2) ||
    (typeof video.currentTime === "number" && video.currentTime > 0 && video.readyState >= 1)
  );

  if (isPlaying && hasData) {
    autoPipToggling = true;
    state._pipAutoInitiating = true;
    try {
      bindPipVideo(video);
      await video.requestPictureInPicture();
      state.pipAutoTriggered = true;
      console.log("[YT Adjust] Auto-PiP activated on tab switch");
    } catch (err) {
      state.pipAutoTriggered = false;
      console.log("[YT Adjust] Auto-PiP activation failed:", err);
    } finally {
      state._pipAutoInitiating = false;
      autoPipToggling = false;
    }
  }
}

/**
 * Automatically exits Picture-in-Picture if it was previously auto-triggered on tab switch.
 *
 * @returns {Promise<void>}
 */
async function exitAutoPip() {
  if (state.pipAutoTriggered && document.pictureInPictureElement) {
    autoPipToggling = true;
    try {
      state.pipAutoTriggered = false;
      await document.exitPictureInPicture();
      console.log("[YT Adjust] Auto-PiP exited on tab return");

      // YouTube's player has its own internal PiP state tracking. When we exit PiP
      // programmatically, the browser fires leavepictureinpicture on the video element,
      // but YouTube's player UI layer may not process it in time. This leaves the
      // "Playing in picture-in-picture" overlay stuck on screen with a black video area.
      // We run cleanup in 3 staggered passes because YouTube's internal state
      // updates asynchronously at unpredictable timing.
      setTimeout(() => { forceExitYouTubePipState(); }, 100);
      setTimeout(() => { forceExitYouTubePipState(); }, 500);
      setTimeout(() => { forceExitYouTubePipState(); }, 1500);
    } catch (err) {
      console.log("[YT Adjust] Auto-PiP exit failed:", err);
    } finally {
      autoPipToggling = false;
    }
  }
  state.pipAutoTriggered = false;
}

/**
 * Force-clears YouTube's internal "Playing in picture-in-picture" overlay state.
 * YouTube's player keeps its own PiP mode tracking separate from the browser's
 * PiP API. When we programmatically call document.exitPictureInPicture(),
 * the browser closes the PiP window, but YouTube's player UI may remain stuck
 * showing the black overlay with "Playing in picture-in-picture" text.
 *
 * This function uses multiple strategies because YouTube frequently changes
 * its internal class names. Rather than hardcoding specific classes, we:
 * 1. Dynamically find and remove ALL classes containing "pip" from the player
 * 2. Find the overlay by its visible text content ("Playing in picture-in-picture")
 * 3. Force video element visibility and re-render via pause/play cycle
 * 4. Dispatch resize to trigger YouTube's internal dimension recalculation
 *
 * Called with a delay after exitPictureInPicture() and also as a safety net
 * from onLeavePictureInPicture(). Runs multiple passes with staggered timing
 * to handle YouTube's async internal state updates.
 *
 * @returns {void}
 */
function forceExitYouTubePipState() {
  // Don't clean up if PiP is actually still active (race condition guard)
  if (document.pictureInPictureElement) return;

  const moviePlayer = getPlayer();
  if (!moviePlayer) return;

  // --- Strategy 1: Remove ALL pip-related CSS classes from #movie_player ---
  // YouTube uses obfuscated class names that change with updates, so we scan
  // the full classList for anything containing "pip" (case-insensitive).
  const classesToRemove = [];
  for (const cls of moviePlayer.classList) {
    if (cls.toLowerCase().includes("pip")) {
      classesToRemove.push(cls);
    }
  }
  if (classesToRemove.length > 0) {
    moviePlayer.classList.remove(...classesToRemove);
    console.log("[YT Adjust] Removed PiP classes from player:", classesToRemove.join(", "));
  }

  // --- Strategy 2: Find and hide the overlay by its text content ---
  // The "Playing in picture-in-picture" overlay is a container inside #movie_player.
  // We locate it by searching for elements whose textContent matches, then walk up
  // to the nearest positioned container and hide it.
  const walker = document.createTreeWalker(moviePlayer, NodeFilter.SHOW_TEXT, null);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const text = (textNode.textContent || "").trim().toLowerCase();
    if (text.includes("playing in picture-in-picture") || text.includes("picture-in-picture")) {
      // Walk up from the text node to find the overlay container
      let overlay = /** @type {HTMLElement | null} */ (textNode.parentElement);
      // Go up a few levels to find the actual overlay wrapper (not just the span)
      for (let i = 0; i < 5 && overlay; i++) {
        if (overlay === moviePlayer) break;
        const style = window.getComputedStyle(overlay);
        // The overlay container is typically absolutely positioned and covers the player
        if (style.position === "absolute" || style.position === "fixed") {
          overlay.style.display = "none";
          console.log("[YT Adjust] Hidden PiP overlay container:", overlay.className || overlay.tagName);
          break;
        }
        overlay = /** @type {HTMLElement | null} */ (overlay.parentElement);
      }
    }
  }

  // --- Strategy 3: Hide any element with pip-related class names inside the player ---
  // Catch any overlay elements we might have missed with the text search.
  const pipSelectors = [
    "[class*='pip' i]",  // Any element with 'pip' in a class name
    "[class*='Pip' i]",
    "[class*='PIP' i]",
  ];
  for (const sel of pipSelectors) {
    try {
      const els = moviePlayer.querySelectorAll(sel);
      for (const el of els) {
        const htmlEl = /** @type {HTMLElement} */ (el);
        const style = window.getComputedStyle(htmlEl);
        // Only hide absolutely positioned overlays, not structural elements
        if (style.position === "absolute" && htmlEl.offsetWidth > 100 && htmlEl.offsetHeight > 100) {
          htmlEl.style.display = "none";
        }
      }
    } catch (e) {
      // querySelectorAll may fail with invalid selectors in some engines
    }
  }

  // --- Strategy 4: Force video element visible and trigger re-render ---
  const video = getVideo();
  if (video) {
    video.style.opacity = "1";
    video.style.visibility = "visible";
    video.style.position = "";

    // Brief pause/play cycle forces the browser to re-render the video frame
    // in the main player viewport instead of the (now-closed) PiP window.
    if (!video.paused && !video.ended) {
      const currentTime = video.currentTime;
      video.pause();
      requestAnimationFrame(() => {
        video.play().catch(() => {});
        // Seek back to exact position to avoid any drift
        if (Math.abs(video.currentTime - currentTime) > 0.5) {
          video.currentTime = currentTime;
        }
      });
    }
  }

  // --- Strategy 5: Dispatch resize event to force YouTube's player recalculation ---
  try {
    window.dispatchEvent(new Event("resize"));
  } catch (e) {}

  // --- Strategy 6: Call YouTube's internal player API methods if available ---
  const anyPlayer = /** @type {any} */ (moviePlayer);
  if (typeof anyPlayer.setInternalSize === "function") {
    try { anyPlayer.setInternalSize(); } catch (e) {}
  }
  // YouTube's player sometimes has a wakeUpControls method
  if (typeof anyPlayer.wakeUpControls === "function") {
    try { anyPlayer.wakeUpControls(); } catch (e) {}
  }
  // setSizeStyle recalculates layout based on theater/default mode
  if (typeof anyPlayer.setSizeStyle === "function") {
    try { anyPlayer.setSizeStyle(false, false); } catch (e) {}
  }
}

/**
 * Handles visibility changes on document to automatically trigger or exit PiP.
 *
 * @returns {void}
 */
function onPipVisibilityChange() {
  if (document.visibilityState === "hidden" || document.hidden) {
    triggerAutoPip();
  } else if (document.visibilityState === "visible") {
    exitAutoPip();
  }
}

/**
 * Handles window blur event. Triggers auto-PiP if the tab is hidden.
 *
 * @returns {void}
 */
function onPipWindowBlur() {
  if (document.visibilityState === "hidden" || document.hidden) {
    triggerAutoPip();
  }
}

/**
 * Handles window focus event. Exits auto-PiP if tab is visible again.
 *
 * @returns {void}
 */
function onPipWindowFocus() {
  if (document.visibilityState === "visible") {
    exitAutoPip();
  }
}

/**
 * Handles entry into Picture-in-Picture mode.
 * Synchronizes manual vs automatic trigger state and cleans up floating mini-player.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onEnterPictureInPicture(e) {
  if (!state._pipAutoInitiating) {
    state.pipAutoTriggered = false;
  }
  // If in-page floating mini-player was active, deactivate it to prevent duplicate player frames
  if (state.miniPlayerActive) {
    deactivateMiniPlayer();
  }
}

/**
 * Clears auto-triggered flag when PiP window is dismissed or closed by user.
 * Restores in-page mini-player if user remains scrolled down past comment threshold.
 *
 * @param {Event} [e]
 * @returns {void}
 */
function onLeavePictureInPicture(e) {
  state.pipAutoTriggered = false;

  // Safety net: clear YouTube's PiP overlay regardless of how PiP was exited
  // (user closed the PiP window, Alt+P toggle, auto-PiP tab return, etc.)
  // Staggered passes to catch YouTube's async internal state updates.
  setTimeout(() => { forceExitYouTubePipState(); }, 100);
  setTimeout(() => { forceExitYouTubePipState(); }, 500);
  setTimeout(() => { forceExitYouTubePipState(); }, 1500);

  if (state.settings.miniPlayerEnabled && location.pathname === "/watch") {
    onMiniPlayerScroll();
  }
}

/**
 * Binds video element with native autoPictureInPicture attribute and PiP listeners.
 * Also clears disablePictureInPicture if present to ensure PiP can activate unimpeded.
 *
 * @param {HTMLVideoElement | null} video
 * @returns {void}
 */
function bindPipVideo(video) {
  if (!video) return;

  const shouldAuto = Boolean(state.settings.pipEnabled && state.settings.pipAutoOnTabSwitch);
  syncMediaSessionPipHandler(shouldAuto);

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

  // Volume boost toggled
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
      if (state.pipAutoTriggered && document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
        state.pipAutoTriggered = false;
      }
    }
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
 * Bootstraps the main world content script.
 * Registers yt-navigate-finish and initializes volume gesture listeners.
 *
 * @returns {void}
 */
function init() {
  document.addEventListener("yt-navigate-finish", onNavigate);
  onNavigate();
  sendToIsolated("REQUEST_SETTINGS", {});
  setupVolumeGesture();
  setupPictureInPicture();
}

/**
 * Handles client-side YouTube SPA navigation events.
 * Cleans up previous video state and initializes features for the new video.
 *
 * @returns {void}
 */
function onNavigate() {
  dismissSkipToast();
  if (state.durationPollInterval) {
    clearInterval(state.durationPollInterval);
    state.durationPollInterval = null;
  }

  if (location.pathname !== "/watch") {
    stopSegmentMonitor();
    teardownMiniPlayer();
    const overlay = document.getElementById("yt-adjust-seekbar-overlay");
    if (overlay) overlay.remove();
    if (state.pipAutoTriggered && document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      state.pipAutoTriggered = false;
    }
    return;
  }

  state.skippedSegments.clear();
  state.qualityRetryCount = 0;
  if (state.qualityRetryTimer) {
    clearTimeout(state.qualityRetryTimer);
  }

  state.miniPlayerDismissed = false;
  deactivateMiniPlayer();

  if (state.settings.qualityEnabled) {
    setTimeout(applyQuality, 1500);
  }

  const videoId = new URLSearchParams(location.search).get("v");
  if (videoId) {
    sendToIsolated("REQUEST_SEGMENTS", { videoId });
  }

  // Re-bind speed control and PiP to new video and re-apply custom speed immediately
  const video = getVideo();
  bindSpeedVideo(video);
  bindPipVideo(video);
  if (state.customPlaybackRate && Math.abs(state.customPlaybackRate - 1.0) >= 0.01) {
    if (video) video.playbackRate = state.customPlaybackRate;
    updateSpeedButton(state.customPlaybackRate);
  } else {
    updateSpeedButton(video ? video.playbackRate : 1.0);
  }

  setTimeout(() => {
    if (state.settings.speedControlEnabled) injectSpeedButton();
    const v = getVideo();
    if (v) {
      bindSpeedVideo(v);
      bindPipVideo(v);
    }
    if (state.settings.volumeBoostEnabled) setupVolumeBoost();
    setupMiniPlayer();
    setupPictureInPicture();
  }, 2000);
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
console.log("[YT Adjust] Main world script loaded (v2.3.2)");
