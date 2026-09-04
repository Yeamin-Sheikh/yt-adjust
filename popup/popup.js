/**
 * YT Adjust — Popup Settings Management (v2.3.1)
 * ===============================================
 * Handles loading, updating, and persisting extension settings to chrome.storage.sync.
 * Every user interaction is saved instantly without requiring a manual save button.
 * Content scripts (isolated.js and main.js) detect changes in real time
 * via chrome.storage.onChanged listeners and apply adjustments immediately.
 *
 * Defensive design features:
 * 1. Strongly typed PopupElements interface to catch DOM query discrepancies.
 * 2. Null guards on all cached DOM elements and visibility modifiers.
 * 3. Array verification on sponsorblockCategories before testing inclusion.
 * 4. Number.isFinite validation before persisting numerical sliders and step selects.
 * 5. chrome.runtime.lastError checks on all storage operations.
 */

"use strict";


/**
 * @typedef {Object} PopupElements
 * @property {HTMLInputElement | null} qualityEnabled - Checkbox for auto quality enforcement
 * @property {HTMLSelectElement | null} qualitySelect - Dropdown for preferred resolution
 * @property {HTMLElement | null} qualitySelectorRow - Container row for quality dropdown
 * @property {HTMLInputElement | null} sponsorblockEnabled - Checkbox for SponsorBlock skipping
 * @property {HTMLElement | null} sponsorblockSettings - Sub-settings container for SponsorBlock
 * @property {HTMLInputElement | null} sponsorblockNotify - Checkbox for skip toast notifications
 * @property {NodeListOf<HTMLInputElement>} categoryCbs - NodeList of category checkboxes
 * @property {HTMLInputElement | null} volumeGestureEnabled - Checkbox for right-click + scroll volume
 * @property {HTMLElement | null} volumeSettings - Container row for volume slider
 * @property {HTMLInputElement | null} volumeStep - Range input for volume adjustment step size
 * @property {HTMLElement | null} volumeStepValue - Text label displaying current volume percentage
 * @property {HTMLInputElement | null} speedControlEnabled - Checkbox for Ctrl + scroll speed control
 * @property {HTMLSelectElement | null} speedStep - Dropdown for speed adjustment step rate
 * @property {HTMLElement | null} speedSelectorRow - Container row for speed step dropdown
 * @property {HTMLInputElement | null} volumeBoostEnabled - Checkbox for Web Audio volume boost button
 * @property {HTMLInputElement | null} miniPlayerEnabled - Checkbox for scroll-to-mini-player
 * @property {HTMLInputElement | null} pipEnabled - Checkbox for Picture-in-Picture feature
 * @property {HTMLInputElement | null} pipAutoOnTabSwitch - Checkbox for auto-PiP on tab switch
 * @property {HTMLElement | null} pipSettings - Container for Picture-in-Picture sub-settings
 */

// Default configuration matching content/isolated.js and content/main.js
/** @type {ExtensionSettings} */
const DEFAULT_SETTINGS = {
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
};

// Cached DOM element references
/** @type {PopupElements} */
let els = {
  qualityEnabled: null,
  qualitySelect: null,
  qualitySelectorRow: null,
  sponsorblockEnabled: null,
  sponsorblockSettings: null,
  sponsorblockNotify: null,
  categoryCbs: /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(".category-cb")),
  volumeGestureEnabled: null,
  volumeSettings: null,
  volumeStep: null,
  volumeStepValue: null,
  speedControlEnabled: null,
  speedStep: null,
  speedSelectorRow: null,
  volumeBoostEnabled: null,
  miniPlayerEnabled: null,
  pipEnabled: null,
  pipAutoOnTabSwitch: null,
  pipSettings: null,
};

/**
 * Caches all popup interactive elements from the DOM.
 * Casts elements to their specific HTML types and logs warnings if any are missing.
 *
 * @returns {void}
 */
function cacheElements() {
  els = {
    // 1. Auto Quality
    qualityEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("qualityEnabled")),
    qualitySelect: /** @type {HTMLSelectElement | null} */ (document.getElementById("qualitySelect")),
    qualitySelectorRow: document.getElementById("qualitySelectorRow"),

    // 2. SponsorBlock
    sponsorblockEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("sponsorblockEnabled")),
    sponsorblockSettings: document.getElementById("sponsorblockSettings"),
    sponsorblockNotify: /** @type {HTMLInputElement | null} */ (document.getElementById("sponsorblockNotify")),
    categoryCbs: /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(".category-cb")),

    // 3. Volume Gestures
    volumeGestureEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("volumeGestureEnabled")),
    volumeSettings: document.getElementById("volumeSettings"),
    volumeStep: /** @type {HTMLInputElement | null} */ (document.getElementById("volumeStep")),
    volumeStepValue: document.getElementById("volumeStepValue"),

    // 4. Speed Control
    speedControlEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("speedControlEnabled")),
    speedStep: /** @type {HTMLSelectElement | null} */ (document.getElementById("speedStep")),
    speedSelectorRow: document.getElementById("speedSelectorRow"),

    // 5. Volume Boost
    volumeBoostEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("volumeBoostEnabled")),

    // 6. Mini Player
    miniPlayerEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("miniPlayerEnabled")),

    // 7. Picture-in-Picture
    pipEnabled: /** @type {HTMLInputElement | null} */ (document.getElementById("pipEnabled")),
    pipAutoOnTabSwitch: /** @type {HTMLInputElement | null} */ (document.getElementById("pipAutoOnTabSwitch")),
    pipSettings: document.getElementById("pipSettings"),
  };
}

/**
 * Initializes the popup controller.
 * Caches elements, loads stored settings from chrome.storage.sync,
 * and attaches change and input listeners to interactive inputs.
 *
 * @returns {void}
 */
function initPopup() {
  cacheElements();
  // Hydrate instantaneously from synchronous localStorage cache to prevent opening delay
  try {
    if (typeof localStorage !== "undefined") {
      const cached = localStorage.getItem("yt_adjust_popup_settings");
      if (cached) {
        applySettings(/** @type {ExtensionSettings} */ (JSON.parse(cached)));
      }
    }
  } catch (e) {
    // localStorage unavailable or restricted
  }
  loadSettings();
  attachListeners();
}

/**
 * Populates popup UI inputs and visibility from a settings object.
 *
 * @param {ExtensionSettings} settings - Settings object to apply to DOM
 * @returns {void}
 */
function applySettings(settings) {
  // 1. Quality Settings
  if (els.qualityEnabled) els.qualityEnabled.checked = Boolean(settings.qualityEnabled);
  if (els.qualitySelect && typeof settings.quality === "string") {
    els.qualitySelect.value = settings.quality;
  }
  toggleVisibility(els.qualitySelect, Boolean(settings.qualityEnabled));

  // 2. SponsorBlock Settings
  if (els.sponsorblockEnabled) els.sponsorblockEnabled.checked = Boolean(settings.sponsorblockEnabled);
  if (els.sponsorblockNotify) els.sponsorblockNotify.checked = Boolean(settings.sponsorblockNotify);
  toggleVisibility(els.sponsorblockSettings, Boolean(settings.sponsorblockEnabled));

  // Restore category checkboxes matching the saved array
  const categories = Array.isArray(settings.sponsorblockCategories)
    ? settings.sponsorblockCategories
    : DEFAULT_SETTINGS.sponsorblockCategories;

  if (els.categoryCbs) {
    els.categoryCbs.forEach((cb) => {
      if (cb) cb.checked = categories.includes(cb.value);
    });
  }

  // 3. Volume Gesture Settings
  if (els.volumeGestureEnabled) els.volumeGestureEnabled.checked = Boolean(settings.volumeGestureEnabled);
  const volumeStepNum = typeof settings.volumeStep === "number" ? settings.volumeStep : 5;
  if (els.volumeStep) els.volumeStep.value = String(volumeStepNum);
  if (els.volumeStepValue) els.volumeStepValue.textContent = `${volumeStepNum}%`;
  toggleVisibility(els.volumeSettings, Boolean(settings.volumeGestureEnabled));

  // 4. Speed Control Settings
  if (els.speedControlEnabled) els.speedControlEnabled.checked = Boolean(settings.speedControlEnabled);
  const speedStepNum = typeof settings.speedStep === "number" ? settings.speedStep : 0.25;
  if (els.speedStep) els.speedStep.value = String(speedStepNum);
  toggleVisibility(els.speedStep, Boolean(settings.speedControlEnabled));

  // 5. Volume Boost Settings
  if (els.volumeBoostEnabled) els.volumeBoostEnabled.checked = Boolean(settings.volumeBoostEnabled);

  // 6. Mini Player Settings
  if (els.miniPlayerEnabled) els.miniPlayerEnabled.checked = Boolean(settings.miniPlayerEnabled);

  // 7. Picture-in-Picture Settings
  if (els.pipEnabled) els.pipEnabled.checked = Boolean(settings.pipEnabled);
  if (els.pipAutoOnTabSwitch) els.pipAutoOnTabSwitch.checked = Boolean(settings.pipAutoOnTabSwitch);
  toggleVisibility(els.pipSettings, Boolean(settings.pipEnabled));
}

/**
 * Loads saved settings from chrome.storage.sync and populates the UI controls.
 * Applies defensive checks for runtime errors and corrupt settings data.
 *
 * @returns {void}
 */
function loadSettings() {
  if (typeof chrome === "undefined" || !chrome?.storage?.sync?.get) {
    console.warn("[YT Adjust Popup] chrome.storage.sync is unavailable");
    return;
  }

  chrome.storage.sync.get(DEFAULT_SETTINGS, (stored) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.error("[YT Adjust Popup] Error loading settings:", chrome.runtime.lastError.message);
      return;
    }

    const settings = /** @type {ExtensionSettings} */ ({
      ...DEFAULT_SETTINGS,
      ...(stored && typeof stored === "object" ? stored : {}),
    });

    applySettings(settings);

    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("yt_adjust_popup_settings", JSON.stringify(settings));
      }
    } catch (e) {}
  });
}

/**
 * Attaches change and input event listeners to interactive inputs.
 * Ensures user input is validated before committing values to storage.
 *
 * @returns {void}
 */
function attachListeners() {
  // -------------------------------------------------------------------------
  // 1. Quality Listeners
  // -------------------------------------------------------------------------
  if (els.qualityEnabled) {
    els.qualityEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("qualityEnabled", target.checked);
      toggleVisibility(els.qualitySelect, target.checked);
    });
  }

  if (els.qualitySelect) {
    els.qualitySelect.addEventListener("change", (e) => {
      const target = /** @type {HTMLSelectElement} */ (e.target);
      saveSetting("quality", target.value);
    });
  }

  // -------------------------------------------------------------------------
  // 2. SponsorBlock Listeners
  // -------------------------------------------------------------------------
  if (els.sponsorblockEnabled) {
    els.sponsorblockEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("sponsorblockEnabled", target.checked);
      toggleVisibility(els.sponsorblockSettings, target.checked);
    });
  }

  if (els.sponsorblockNotify) {
    els.sponsorblockNotify.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("sponsorblockNotify", target.checked);
    });
  }

  if (els.categoryCbs) {
    els.categoryCbs.forEach((cb) => {
      cb.addEventListener("change", () => {
        const activeCategories = Array.from(els.categoryCbs)
          .filter((checkbox) => checkbox.checked)
          .map((checkbox) => checkbox.value);
        saveSetting("sponsorblockCategories", activeCategories);
      });
    });
  }

  // -------------------------------------------------------------------------
  // 3. Volume Gesture Listeners
  // -------------------------------------------------------------------------
  if (els.volumeGestureEnabled) {
    els.volumeGestureEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("volumeGestureEnabled", target.checked);
      toggleVisibility(els.volumeSettings, target.checked);
    });
  }

  // Real-time text display update while dragging slider
  if (els.volumeStep) {
    els.volumeStep.addEventListener("input", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      if (els.volumeStepValue) {
        els.volumeStepValue.textContent = `${target.value}%`;
      }
    });

    // Commit setting to storage on change release
    els.volumeStep.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      const parsed = parseInt(target.value, 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 10) {
        saveSetting("volumeStep", parsed);
      }
    });
  }

  // -------------------------------------------------------------------------
  // 4. Speed Control Listeners
  // -------------------------------------------------------------------------
  if (els.speedControlEnabled) {
    els.speedControlEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("speedControlEnabled", target.checked);
      toggleVisibility(els.speedStep, target.checked);
    });
  }

  if (els.speedStep) {
    els.speedStep.addEventListener("change", (e) => {
      const target = /** @type {HTMLSelectElement} */ (e.target);
      const parsed = parseFloat(target.value);
      if (Number.isFinite(parsed) && parsed > 0) {
        saveSetting("speedStep", parsed);
      }
    });
  }

  // -------------------------------------------------------------------------
  // 5. Volume Boost Listener
  // -------------------------------------------------------------------------
  if (els.volumeBoostEnabled) {
    els.volumeBoostEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("volumeBoostEnabled", target.checked);
    });
  }

  // -------------------------------------------------------------------------
  // 6. Mini Player Listener
  // -------------------------------------------------------------------------
  if (els.miniPlayerEnabled) {
    els.miniPlayerEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("miniPlayerEnabled", target.checked);
    });
  }

  // -------------------------------------------------------------------------
  // 7. Picture-in-Picture Listeners
  // -------------------------------------------------------------------------
  if (els.pipEnabled) {
    els.pipEnabled.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("pipEnabled", target.checked);
      toggleVisibility(els.pipSettings, target.checked);
    });
  }

  if (els.pipAutoOnTabSwitch) {
    els.pipAutoOnTabSwitch.addEventListener("change", (e) => {
      const target = /** @type {HTMLInputElement} */ (e.target);
      saveSetting("pipAutoOnTabSwitch", target.checked);
    });
  }
}

/**
 * Persists an individual setting key-value pair to chrome.storage.sync.
 * Wrapped in try/catch and checks chrome.runtime.lastError to guard against
 * quota errors or extension invalidation.
 *
 * @param {string} key - The setting property name
 * @param {any} value - The setting value to store
 * @returns {void}
 */
function saveSetting(key, value) {
  if (typeof chrome === "undefined" || !chrome?.storage?.sync?.set) {
    console.warn("[YT Adjust Popup] Cannot save setting: chrome.storage.sync is unavailable");
    return;
  }

  try {
    chrome.storage.sync.set({ [key]: value }, () => {
      if (chrome.runtime && chrome.runtime.lastError) {
        console.error(`[YT Adjust Popup] Failed to save setting "${key}":`, chrome.runtime.lastError.message);
      }
    });
  } catch (saveError) {
    console.error(`[YT Adjust Popup] Exception while saving setting "${key}":`, saveError);
  }

  // Update synchronous cache immediately for instant subsequent opens
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem("yt_adjust_popup_settings");
      const current = raw ? JSON.parse(raw) : { ...DEFAULT_SETTINGS };
      current[key] = value;
      localStorage.setItem("yt_adjust_popup_settings", JSON.stringify(current));
    }
  } catch (e) {}
}

/**
 * Adjusts container opacity and pointer-events to visually enable or disable child settings.
 * Includes a null check to prevent exceptions if an element reference is missing.
 *
 * @param {HTMLElement | null} element - The container element to adjust
 * @param {boolean} isVisible - True if active and interactive, false if dimmed and non-interactive
 * @returns {void}
 */
function toggleVisibility(element, isVisible) {
  if (!element) return;
  element.style.opacity = isVisible ? "1" : "0.5";
  element.style.pointerEvents = isVisible ? "auto" : "none";
}

// ---------------------------------------------------------------------------
// Lifecycle bootstrap
// ---------------------------------------------------------------------------
// Ensures initialization executes whether the script loads before or after DOM parsing.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPopup);
} else {
  initPopup();
}
