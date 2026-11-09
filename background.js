// =============================================================================
// YT Adjust — Background Service Worker (v2.4.3)
// =============================================================================
// Why this worker exists:
// In Manifest V3, content scripts (content/isolated.js) execute inside the
// renderer process of the host page (https://www.youtube.com). Chromium's site
// isolation and cross-origin frame security rules prohibit content scripts from
// issuing cross-origin fetch() requests directly to third-party APIs such as
// https://sponsor.ajay.app, even when declared in manifest host_permissions.
// Attempting a direct fetch from the content script triggers a Blink security
// error ("Unsafe attempt to load URL ... from frame with URL ... Domains,
// protocols and ports must match").
//
// By routing SponsorBlock API lookups through this stateless background service
// worker via chrome.runtime.sendMessage, the network request originates from the
// extension's own origin (chrome-extension://<id>), where host_permissions grant
// clean cross-origin access without triggering frame security errors.
// =============================================================================

/**
 * Allowed URL prefix for SponsorBlock hash-prefix segment lookups.
 * Enforcing a strict prefix prevents this message handler from being misused
 * as a general-purpose cross-origin fetch proxy.
 */
const ALLOWED_SB_PREFIX = "https://sponsor.ajay.app/api/skipSegments/";

/**
 * Network timeout in milliseconds for SponsorBlock API lookups.
 */
const SB_FETCH_TIMEOUT_MS = 5000;

/**
 * Executes a SponsorBlock API GET request from the extension service worker
 * context with a strict 5-second abort timeout and no ambient credentials.
 *
 * @param {string} url - Validated SponsorBlock skipSegments URL
 * @returns {Promise<SponsorBlockProxyResponse>}
 */
async function handleSponsorBlockFetch(url) {
  if (typeof url !== "string" || !url.startsWith(ALLOWED_SB_PREFIX)) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: "InvalidUrlError",
      message: "Blocked URL outside SponsorBlock skipSegments endpoint",
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SB_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
    });
    clearTimeout(timeoutId);

    // HTTP 404 from SponsorBlock indicates no segments exist for this hash prefix
    if (response.status === 404) {
      return {
        ok: true,
        status: 404,
        data: [],
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
      };
    }

    const data = await response.json();
    return {
      ok: true,
      status: 200,
      data,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = Boolean(
      err && typeof err === "object" && "name" in err && err.name === "AbortError"
    );
    const errMsg =
      err && typeof err === "object" && "message" in err && typeof err.message === "string"
        ? err.message
        : String(err);
    return {
      ok: false,
      status: 0,
      data: null,
      error: isAbort ? "AbortError" : "NetworkError",
      message: errMsg,
    };
  }
}

// Register the message listener at the top level of the service worker so
// Chromium can wake the worker on demand when a content script sends a message.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "PAUSE_OTHER_TABS") {
      const senderTabId =
        sender && sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;
      const sourceInstanceId = typeof message.tabId === "string" ? message.tabId : "";

      if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.query === "function") {
        try {
          chrome.tabs.query({ url: "https://*.youtube.com/*" }, (tabs) => {
            if (chrome.runtime && chrome.runtime.lastError) return;
            if (!Array.isArray(tabs)) return;
            for (const tab of tabs) {
              if (!tab || typeof tab.id !== "number") continue;
              if (senderTabId !== null && tab.id === senderTabId) continue;
              try {
                chrome.tabs.sendMessage(
                  tab.id,
                  {
                    type: "PAUSE_TAB_VIDEO",
                    tabId: sourceInstanceId,
                  },
                  () => {
                    // Suppress connection warnings on discarded or unloaded tabs
                    void (chrome.runtime && chrome.runtime.lastError);
                  }
                );
              } catch (e) {}
            }
          });
        } catch (e) {}
      }

      sendResponse({ ok: true });
      return false;
    }

    if (message.type !== "FETCH_SPONSORBLOCK") {
      return false;
    }

    handleSponsorBlockFetch(message.url)
      .then((result) => {
        sendResponse(result);
      })
      .catch((err) => {
        sendResponse({
          ok: false,
          status: 0,
          data: null,
          error: "UnhandledError",
          message: err && err.message ? String(err.message) : String(err),
        });
      });

    // Return true synchronously to keep the message channel open for async sendResponse
    return true;
  });
}
