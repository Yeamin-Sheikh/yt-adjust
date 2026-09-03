# YT Adjust

Lightweight Chromium extension that replaces Enhancer for YouTube and SponsorBlock with a single, focused tool. No accounts, no telemetry, no bloat.

## Features

**Auto quality.** Forces your preferred video resolution on every video. Default is 1080p. Falls back to the highest available quality if your preference is not offered. Uses settings menu automation since YouTube deprecated the old quality API.

**Sponsor skip.** Auto-skips sponsored segments, self-promotions, and interaction reminders using the free [SponsorBlock API](https://sponsor.ajay.app/). Uses a privacy-friendly hash-prefix lookup. Thin subtle white segment markers appear on the seekbar. When a segment is skipped, a subtle notification appears on the right with an Undo button and Enter key shortcut.

**Volume gesture.** Hold right-click on the video player and scroll up/down to adjust volume. Each scroll tick changes volume by a configurable step (default 5%). A centered subtle overlay shows the current volume. Right-click without scrolling opens the context menu normally.

**Speed control.** Hold Shift and scroll over the video, or hover over the speed button in the player controls and scroll to adjust speed (0.25x to 4x). At default 1x, the button is compact showing only the speedometer icon. When adjusted, it dynamically expands to display the speed badge. Click it anytime to reset to 1x and collapse back to the compact icon.

**Volume boost.** Amplifies audio to 150% using the Web Audio API. A circular pill button with sound waves and lightning icon `((⚡))` appears in the controls next to the volume slider, blending in with YouTube's player UI. Click to toggle boost on/off.

**Scroll mini-player.** When you scroll down past the video to read comments, the video floats in a 480x270 box in the top-right corner. The video scales cleanly without cropping. Hides channel watermarks, info cards, and end screens while in mini mode. Scrolling back up restores the normal layout without black screens or layout shifts.

**Picture-in-Picture.** Native HTML5 Picture-in-Picture. Toggle PiP on or off with the Alt+P shortcut. Auto-PiP mode activates Picture-in-Picture automatically when switching away from the playing video tab, and restores regular playback when returning to the tab.

## Installation

1. Clone or download this folder
2. Open `chrome://extensions` in Chrome (or any Chromium browser)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `YT Adjust` directory
5. The extension icon appears in your toolbar

## Configuration

Click the extension icon to open the settings popup. All changes take effect instantly, no reload needed.

| Setting | Default | Description |
|---|---|---|
| Auto quality | On | Force a specific video resolution |
| Preferred quality | 1080p | 4K / 1440p / 1080p / 720p / 480p / Auto |
| SponsorBlock | On | Auto-skip community-reported sponsor segments |
| Skip categories | Sponsor, Self-promo, Interaction | Which segment types to skip |
| Skip notifications | On | Show a toast when a segment is skipped |
| Volume gesture | On | Right-click + scroll to adjust volume |
| Volume step | 5% | How much each scroll tick changes volume (1-10%) |
| Speed control | On | Shift + scroll or hover speed button + scroll |
| Speed step | 0.25x | Step size per scroll tick (0.1x, 0.25x, 0.5x) |
| Volume boost | On | Show boost button in player controls (150%) |
| Mini player | On | Float video when scrolling down to comments |
| Picture-in-Picture | On | Native Picture-in-Picture support |
| Auto-PiP on tab switch | Off | Automatically activate PiP when switching away from the tab |

## Keyboard and mouse shortcuts

| Shortcut | Action |
|---|---|
| Hold right-click + scroll | Adjust volume up/down |
| Hold Shift + scroll over video | Adjust playback speed |
| Hover over speed button + scroll | Adjust playback speed |
| Click speed button in controls | Reset speed to 1x |
| Click boost button `((⚡))` | Toggle 150% volume boost |
| Press Enter while skip toast is visible | Undo skip and jump back |
| Alt + P | Toggle Picture-in-Picture on/off |

## Development and testing

```bash
# Type check without compiling JS to TS
npm run typecheck

# Syntax validation across all scripts
npm run lint:syntax

# Run adversarial and empirical stress test suites
npm test
```

## Architecture

Manifest V3 with two content scripts that communicate via `window.postMessage`:

- **content/isolated.js** (isolated world): Has access to `chrome.storage.sync` and makes cross-origin fetch calls to the SponsorBlock API. Detects YouTube SPA navigation and relays settings + segment data to the main world script.

- **content/main.js** (MAIN world): Has direct access to YouTube's player API. Seven modules: quality (settings menu automation), sponsor skip (`requestVideoFrameCallback` polling), volume gesture (capture-phase listeners), speed control (Shift+scroll, button hover scroll, dynamic capsule highlight), volume boost (Web Audio API GainNode with YouTube pill styling), scroll mini-player (dynamic viewport detection and DOM containment), and picture-in-picture (Alt+P shortcut, auto-PiP on tab switch).

- **popup/**: Vanilla HTML/CSS/JS settings panel. Saves to `chrome.storage.sync` for instant updates.

## File structure

```
YT Adjust/
├── .gitignore             # Ignores node_modules and logs
├── manifest.json          # MV3 manifest (v2.3.0)
├── package.json           # Scripts and devDependencies
├── tsconfig.json          # TypeScript checkJs configuration
├── README.md
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── content/
│   ├── isolated.js        # Chrome APIs, SponsorBlock fetch, JSDoc typings
│   └── main.js            # YouTube player API, all 7 modules, JSDoc typings
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js           # Settings UI logic, deep-merge storage, JSDoc typings
├── tests/
│   ├── adversarial-stress-suite.mjs # Storage, network, and DOM stress tests
│   └── empirical-challenger.js      # Reparenting, audio, CSP, and null guard tests
└── types/
    └── extension.d.ts     # Ambient Chrome and YouTube interface definitions
```

## Credits

Developed and maintained by **Sheikh Technology LLC**.

SponsorBlock segment data provided by [sponsor.ajay.app](https://sponsor.ajay.app/), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
