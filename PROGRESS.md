# Development progress log

**Project:** YT Adjust
**Started:** 2026-11-04
**Last updated:** 2026-11-09 14:35 BDT (UTC+6)

---

## Current status

- **Phase:** Active development and hardening
- **Progress:** 41/41 tasks complete (100%)
- **Active task:** v2.4.5 speed button click-cycling (+0.25x steps from 1.0x up to 3.0x, resetting to 1.0x at 3.0x while keeping >3.0x scroll-only) complete
- **Blockers:** None

---

## Task checklist

### Phase 1: Manifest, build, and type-check hygiene
- [x] Add `minimum_chrome_version`, `exclude_matches`, and `action.default_title` to `manifest.json`
- [x] Fix `npm run lint:syntax` in `package.json` for cross-shell execution
- [x] Enable `strictNullChecks` in `tsconfig.json` and update `types/extension.d.ts`
- [x] Move root `.zip` release archives to `releases/` and update `.gitignore`

### Phase 2: Isolated world (`content/isolated.js`)
- [x] Deduplicate concurrent `fetchSegments()` requests via `inFlightRequests` map
- [x] Fix `setInSegmentCache()` LRU refresh on existing key updates
- [x] Scope `getVideoId()` to `/watch` (`?v=`) to match `content/main.js`
- [x] Validate `category` and `UUID` fields in `fetchSegments()` and use `console.warn`
- [x] Dispatch `SETTINGS_UPDATE` on non-watch pages and guard stale async `videoId` responses

### Phase 3: Main world (`content/main.js`)
- [x] Add `isAdPlaying()` guard across Auto Quality, SponsorBlock, Speed Control, and Auto-PiP
- [x] Fix `setQualityViaMenu` mutex, `"Auto"` fallback guard, and `video.videoHeight` verification
- [x] Scope `dismissPremiumModal()` strictly to YouTube Premium upsell dialogs
- [x] Track `_segmentMonitorVideo` and prune `skippedSegments` on backward `seeked` events
- [x] Reset `isRightMouseDown` on `blur` and verify `e.buttons & 2` in `setupVolumeGesture()`
- [x] Gate speed button scroll by `speedControlEnabled` and remove dead bubble-phase wheel listener
- [x] Re-bind Web Audio pipeline in `ensureAudioPipeline()` when `<video>` element is replaced
- [x] Guard `onMiniPlayerWindowResize()` against internal synthetic resize events and handle `fullscreenchange`
- [x] Deduplicate staggered `forceExitYouTubePipState()` timers and guard `setSizeStyle` during mini-player
- [x] Clear stale SponsorBlock segments and timers immediately in `onNavigate()` and validate `videoId` in `handleSegmentsUpdate()`

### Phase 4: Popup UI & accessibility (`popup/`)
- [x] Fix `.toggle-switch.mini input:checked + .slider:before` CSS selector in `popup.css`
- [x] Replace `display: none` with `.visually-hidden` clip-path rules and add `:focus-visible` rings
- [x] Add `<label for="...">`, `aria-label`, `aria-hidden="true"`, and `music_offtopic` chip in `popup.html`
- [x] Add `inert`, storage fallback, and value validation in `popup.js`

### Phase 5: Test suite expansion & v2.3.11 release parity
- [x] Fix class token matching and comment stripping in `tests/empirical-challenger.js`
- [x] Bump version to `2.4.0` across all files (`manifest.json`, `package.json`, `package-lock.json`, `background.js`, `popup/popup.html`, `popup/popup.js`, `content/isolated.js`, `content/main.js`, `README.md`) and build `releases/yt-adjust-v2.4.0.zip`
- [x] Ensure Chrome and Helium storage and Auto-PiP parity (`saveSetting` dual sync+local write mirror, `sanitizeSettings` in `isolated.js`, and Helium `onPipWindowBlur` compatibility)
- [x] Optimize capture-phase `wheel` and `mousemove` listeners and `isAdPlaying()` for minimal CPU overhead
- [x] Fix Theater Mode ("Creator Mode") vs. Standard Mode mini-player scroll round-trip blowout (`activateMiniPlayer`, `onMiniPlayerWindowResize`, `deactivateMiniPlayer`, `enforcePlayerContainment`)
- [x] Route cross-origin SponsorBlock `fetch` requests through a stateless Manifest V3 Service Worker (`background.js`) via `chrome.runtime.sendMessage` to eliminate frame-origin security errors in `chrome://extensions`
- [x] Halt 60fps `startSegmentMonitor` frame callback loop once all segments are passed or skipped, resuming automatically on backward `seeked` events
- [x] Add O(1) `window.scrollY` fast-path bounds checks to `onMiniPlayerScroll` and attach PiP `mousemove` listener dynamically only while in PiP
- [x] Add `isLiveStream()` guard to prevent sticky `customPlaybackRate > 1.0x` from stalling live broadcasts and skip seekbar overlays on live streams
- [x] Add `syncMiniPlayerTheaterToggle()` to handle toggling Theater Mode (`t`) while the mini-player is active
- [x] Add color-coded SponsorBlock seekbar markers (`CATEGORY_COLORS`) and category chip color dots
- [x] Add configurable Volume Boost levels (`150%`, `200%`, `300%`) and a one-click `Reset` button in `popup/`
- [x] Fix Auto-PiP tab return `"Playing in picture-in-picture"` stuck interstitial via `pipNeedsSurfaceRestore`, Blink `LayoutVideo` re-attachment, and `pipExitedTime` blur cooldown
- [x] Add Cross-Tab Playback Sync (`pauseOtherTabsEnabled`, off by default) to automatically pause other playing YouTube tabs via `BroadcastChannel` and `background.js`
- [x] Eliminate Blink `AutoPictureInPictureTabHelper` vs. `PictureInPictureControllerImpl` Mojo teardown race (`pipEnteredViaMediaSession`, removal of HTML `autopictureinpicture` attribute when MediaSession is supported, and `recoverOrphanedBlinkPipState`)
- [x] Add pre-hydration autoplay detection (`_pendingPlayAnnouncement` + `timeupdate` capture listener) and 4-channel cross-tab sync (`BroadcastChannel`, `localStorage`, `chrome.storage.local` `ytAdjustActivePlaySignal`, and `background.js`)
- [x] Expand test suites to 103 passing tests across `tests/adversarial-stress-suite.mjs` and `tests/empirical-challenger.js` and bump version to `2.4.1`
- [x] Replace menu-click quality selection with silent YouTube Player API (`getAvailableQualityLevels` + `setPlaybackQuality` + `setPlaybackQualityRange`) and double-stringified numeric height `localStorage["yt-player-quality"]` persistence
- [x] Add `.ytp-speedmaster-overlay` ("Hold for 2x") compatibility and `video.defaultPlaybackRate` synchronization in `bindSpeedVideo`
- [x] Guard `Shift + wheel` speed adjustments when `.ytp-settings-shown` / `.ytp-menu-shown` is open and persist volume adjustments to `yt-player-volume`
- [x] Intercept same-video timestamp links (`?t=...`) while the mini-player is active to seek in-place without scrolling to the top
- [x] Fix SponsorBlock `< 0.5s` backward-seek re-arming, chain contiguous/overlapping segments into a single seek, clamp end-of-video skips, add `minWidth: "2px"` seekbar markers, append `&trimUUIDs=5` to `skipSegments` API requests, and expand test suites to 107 passing tests (`v2.4.2`)

---

## Session log

### Session 1 - 2026-11-04 (08:15 - 10:10 BDT)

#### Summary
Conducted a full review of the `YT Adjust` v2.3.10 codebase across `manifest.json`, `content/isolated.js`, `content/main.js`, `popup/`, `types/extension.d.ts`, and `tests/`. Implemented all 24 approved fixes covering race conditions, ad-playback interference, quality menu fallbacks, SponsorBlock backward seeks, Web Audio node re-binding, mini-player resize/fullscreen edge cases, popup keyboard accessibility, strict TypeScript null checking, Theater Mode vs. Standard Mode mini-player restoration, and a Manifest V3 background Service Worker (`background.js`) for cross-origin SponsorBlock requests.

#### Changes made
- `manifest.json`, `background.js` - Added `minimum_chrome_version: "111"`, `default_title: "YT Adjust"`, `exclude_matches` for non-watch YouTube subdomains, and `background.service_worker: "background.js"` to proxy cross-origin SponsorBlock requests from the extension origin rather than the `https://www.youtube.com` content script frame.
- `package.json`, `tsconfig.json`, `types/extension.d.ts`, `.gitignore` - Fixed `lint:syntax`, enabled `strictNullChecks: true`, updated Chrome runtime type definitions (`sendMessage`, `onMessage`), and moved 9 `.zip` archives into `releases/`.
- `content/isolated.js` - Added `inFlightRequests` deduplication, routed `fetchSegments` via `chrome.runtime.sendMessage({ type: "FETCH_SPONSORBLOCK", url })`, fixed `setInSegmentCache` LRU update behavior, aligned `getVideoId()` with `/watch`, normalized `category`/`UUID` fields, and guarded against stale `videoId` race conditions.
- `content/main.js` - Added `isAdPlaying()` guards, `QUALITY_TO_HEIGHT` checks, `setQualityViaMenu` concurrency lock and `"Auto"` fallback guard, backward-seek `skippedSegments` pruning, `_boostBoundVideo` tracking, `isInternalResizeDispatch` guard, `fullscreenchange` handling, `_pipCleanupTimers` deduplication, `onNavigate` cleanup, and Theater Mode + Standard Mode mini-player containment (`enforcePlayerContainment`, pre-mutation style capture, and clamped theater height).
- `popup/popup.html`, `popup/popup.css`, `popup/popup.js` - Fixed mini toggle thumb CSS selector, enabled keyboard navigation with `.visually-hidden` inputs and `:focus-visible` styles, added `music_offtopic` category chip, added `inert` on disabled sections, and added `chrome.storage.local` fallback and input range validation.
- `tests/adversarial-stress-suite.mjs`, `tests/empirical-challenger.js`, `README.md` - Fixed mock DOM class matching and comment stripping, and added 16 new tests bringing the total to 93 passing tests (27 in `adversarial-stress-suite.mjs` and 66 in `empirical-challenger.js`).

#### Decisions & notes
- Retained synchronous execution for `onMiniPlayerScroll` and `onMiniPlayerWindowResize` while short-circuiting redundant DOM queries via `state._miniPlayerAnchor` so layout updates remain immediate and compatible with synchronous test assertions.

### Session 2 - 2026-11-09 (14:10 - 14:36 BDT)

#### Summary
Reverse-engineered `Enhancer for YouTube v3.0.19` and `SponsorBlock v6.1.6` from the uploaded extension ZIP archives and integrated five upgrades into `YT Adjust v2.4.2`. Replaced DOM settings-gear clicking with silent YouTube Player API quality selection, added `.ytp-speedmaster-overlay` ("Hold for 2x") compatibility, guarded `Shift + wheel` when player menus are open, intercepted same-video timestamp links while the mini-player is active, and upgraded SponsorBlock segment chaining, backward-seek re-arming, and API query size (`&trimUUIDs=5`).

#### Changes made
- `content/main.js`, `types/extension.d.ts` - Added `resolveBestAvailableQuality()`, `persistYouTubeQualityStorage()`, `onYtPlayerUpdated()`, and `onDocumentVideoLoadedData()` to silently apply quality via `player.getAvailableQualityLevels()` and `player.setPlaybackQualityRange(q, q)` without opening `.ytp-settings-button`. Added `isSpeedmasterOverlayActive()` and `video.defaultPlaybackRate` sync in `bindSpeedVideo()`. Guarded `Shift + wheel` against `.ytp-settings-shown` / `.ytp-menu-shown`. Added `onMiniPlayerTimestampClick()` and `parseYouTubeTimeParam()` to seek in-place when clicking timestamp links while the mini-player is active. Updated `startSegmentMonitor()` to re-arm `< 0.5s` segments on rewind, chain contiguous/overlapping segments in a single seek, and clamp end-of-video skips.
- `content/isolated.js` - Appended `&trimUUIDs=5` to the SponsorBlock `skipSegments` API query URL.
- `tests/empirical-challenger.js`, `tests/adversarial-stress-suite.mjs`, `README.md`, `manifest.json`, `package.json`, `package-lock.json`, `background.js`, `popup/popup.html`, `popup/popup.js` - Added 4 new tests (107 total passing tests across both suites), bumped version to `2.4.2`, and packaged `releases/yt-adjust-v2.4.2.zip`.
