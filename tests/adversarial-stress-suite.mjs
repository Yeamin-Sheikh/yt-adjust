// =============================================================================
// YT Adjust — Empirical Adversarial Stress Test Suite
// =============================================================================
// Tests content/isolated.js, popup/popup.js, and cross-world postMessage
// communication against adversarial failure modes, corrupted storage, network
// faults, timeouts, DOM null states, and cross-origin spoofing.
// =============================================================================

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const rootDir = path.resolve(".");
const isolatedCode = fs.readFileSync(path.join(rootDir, "content/isolated.js"), "utf8");
const popupCode = fs.readFileSync(path.join(rootDir, "popup/popup.js"), "utf8");
const mainCode = fs.readFileSync(path.join(rootDir, "content/main.js"), "utf8");
const backgroundCode = fs.readFileSync(path.join(rootDir, "background.js"), "utf8");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

function test(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, err });
    console.error(`  [FAIL] ${name}:`, err.message);
  }
}

async function testAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    failures.push({ name, err });
    console.error(`  [FAIL] ${name}:`, err.message);
  }
}

function createIsolatedSandbox(custom = {}) {
  const mockWindow = {
    location: { origin: "https://www.youtube.com", search: "?v=testVideo123", pathname: "/watch" },
    addEventListener: () => {},
    postMessage: () => {}
  };
  mockWindow.window = mockWindow;

  const mockDoc = {
    addEventListener: () => {},
    readyState: "loading"
  };

  return {
    window: mockWindow,
    document: mockDoc,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    URLSearchParams: globalThis.URLSearchParams,
    Map: Map,
    Array: Array,
    Object: Object,
    Set: Set,
    Error: Error,
    DOMException: globalThis.DOMException,
    ...custom
  };
}

console.log("\n=======================================================");
console.log("SUITE 1: content/isolated.js — Storage Failure Resilience");
console.log("=======================================================");

await testAsync("getSettings: falls back to local when sync throws synchronously", async () => {
  const sandbox = createIsolatedSandbox({
    chrome: {
      storage: {
        sync: {
          get: () => {
            throw new Error("Extension context invalidated (sync)");
          }
        },
        local: {
          get: async () => ({ quality: "hd720", volumeStep: 10 })
        }
      }
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.getSettings = getSettings;\n globalThis.DEFAULTS = DEFAULTS;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.getSettings();
  assert.equal(res.quality, "hd720");
  assert.equal(res.volumeStep, 10);
  assert.equal(res.qualityEnabled, true, "merges missing fields from DEFAULTS");
});

await testAsync("getSettings: falls back to local when sync returns rejected Promise", async () => {
  const sandbox = createIsolatedSandbox({
    chrome: {
      storage: {
        sync: {
          get: async () => {
            throw new Error("Async network sync error");
          }
        },
        local: {
          get: async () => ({ speedStep: 0.5 })
        }
      }
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.getSettings = getSettings;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.getSettings();
  assert.equal(res.speedStep, 0.5);
  assert.equal(res.quality, "hd1080");
});

await testAsync("getSettings: falls back to DEFAULTS when sync and local both throw", async () => {
  const sandbox = createIsolatedSandbox({
    chrome: {
      storage: {
        sync: {
          get: async () => {
            throw new Error("Sync failure");
          }
        },
        local: {
          get: async () => {
            throw new Error("Local failure");
          }
        }
      }
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.getSettings = getSettings;\n globalThis.DEFAULTS = DEFAULTS;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.getSettings();
  assert.deepEqual(res, sandbox.DEFAULTS);
});

await testAsync("getSettings: handles sync returning undefined", async () => {
  const sandbox = createIsolatedSandbox({
    chrome: {
      storage: {
        sync: {
          get: async () => undefined
        },
        local: {
          get: async () => undefined
        }
      }
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.getSettings = getSettings;\n globalThis.DEFAULTS = DEFAULTS;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.getSettings();
  assert.deepEqual(res, sandbox.DEFAULTS);
});

await testAsync("getSettings: handles completely missing chrome global", async () => {
  const sandbox = createIsolatedSandbox();
  delete sandbox.chrome;
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.getSettings = getSettings;\n globalThis.DEFAULTS = DEFAULTS;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.getSettings();
  assert.deepEqual(res, sandbox.DEFAULTS);
});

console.log("\n=======================================================");
console.log("SUITE 2: content/isolated.js — fetchSegments Network Resilience");
console.log("=======================================================");

await testAsync("fetchSegments: returns [] immediately on invalid input arguments", async () => {
  const sandbox = createIsolatedSandbox();
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const empty1 = await sandbox.fetchSegments("", ["sponsor"]);
  assert.equal(empty1.length, 0);
  const empty2 = await sandbox.fetchSegments(null, ["sponsor"]);
  assert.equal(empty2.length, 0);
  const empty3 = await sandbox.fetchSegments(12345, ["sponsor"]);
  assert.equal(empty3.length, 0);
  const empty4 = await sandbox.fetchSegments("testId", []);
  assert.equal(empty4.length, 0);
  const empty5 = await sandbox.fetchSegments("testId", null);
  assert.equal(empty5.length, 0);
  const empty6 = await sandbox.fetchSegments("testId", "not-array");
  assert.equal(empty6.length, 0);
});

await testAsync("fetchSegments: handles AbortError (network timeout) cleanly without throw", async () => {
  let warnCalled = false;
  const sandbox = createIsolatedSandbox({
    console: {
      warn: (msg) => {
        if (typeof msg === "string" && msg.includes("timed out")) warnCalled = true;
      },
      error: () => {},
      log: () => {}
    },
    fetch: async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.fetchSegments("timeoutVid", ["sponsor"]);
  assert.equal(res.length, 0);
  assert.equal(warnCalled, true, "should log timeout warning");
});

await testAsync("fetchSegments: handles HTTP 404 response cleanly and caches []", async () => {
  let fetchCallCount = 0;
  const sandbox = createIsolatedSandbox({
    fetch: async () => {
      fetchCallCount++;
      return {
        status: 404,
        ok: false
      };
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res1 = await sandbox.fetchSegments("notFoundVid", ["sponsor"]);
  assert.equal(res1.length, 0);
  assert.equal(fetchCallCount, 1);

  // Second call must hit cache and NOT invoke fetch again
  const res2 = await sandbox.fetchSegments("notFoundVid", ["sponsor"]);
  assert.equal(res2.length, 0);
  assert.equal(fetchCallCount, 1, "second call should be served from segmentCache");
});

await testAsync("fetchSegments: handles HTTP 500 server error cleanly", async () => {
  const sandbox = createIsolatedSandbox({
    fetch: async () => ({
      status: 500,
      ok: false
    })
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.fetchSegments("serverErrVid", ["sponsor"]);
  assert.equal(res.length, 0);
});

await testAsync("fetchSegments: handles non-array JSON payload safely", async () => {
  let warnCalled = false;
  const sandbox = createIsolatedSandbox({
    console: {
      warn: (msg) => {
        if (typeof msg === "string" && msg.includes("not an array")) warnCalled = true;
      },
      error: () => {},
      log: () => {}
    },
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ message: "No segments found object instead of array" })
    })
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.fetchSegments("nonArrayVid", ["sponsor"]);
  assert.equal(res.length, 0);
  assert.equal(warnCalled, true, "warns when payload is not an array");
});

await testAsync("fetchSegments: handles malformed JSON parsing syntax error", async () => {
  const sandbox = createIsolatedSandbox({
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      }
    })
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.fetchSegments("badJsonVid", ["sponsor"]);
  assert.equal(res.length, 0);
});

await testAsync("fetchSegments: correctly filters target videoID and sorts segments defensively", async () => {
  const testVid = "targetVideo1";
  const sandbox = createIsolatedSandbox({
    fetch: async () => ({
      status: 200,
      ok: true,
      json: async () => [
        null,
        { videoID: "otherVideo", segments: [{ segment: [1, 2] }] },
        {
          videoID: testVid,
          segments: [
            { UUID: "seg-3", segment: [45.2, 60.1], category: "sponsor" },
            { UUID: "seg-1", segment: [10.0, 25.5], category: "sponsor" },
            { UUID: "seg-2", segment: [30.0, 40.0], category: "sponsor" },
            // Malformed segment items
            null,
            { segment: null },
            { segment: "not-array" }
          ]
        }
      ]
    })
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const res = await sandbox.fetchSegments(testVid, ["sponsor"]);
  assert.equal(res.length, 3);
  // The first 3 should be properly sorted by start time
  const valid = res.filter(s => s && Array.isArray(s.segment) && typeof s.segment[0] === "number");
  assert.equal(valid[0].UUID, "seg-1");
  assert.equal(valid[1].UUID, "seg-2");
  assert.equal(valid[2].UUID, "seg-3");
});

await testAsync("fetchSegments: cache key normalizes category order", async () => {
  let fetchCount = 0;
  const sandbox = createIsolatedSandbox({
    fetch: async () => {
      fetchCount++;
      return {
        status: 200,
        ok: true,
        json: async () => [{ videoID: "normVid", segments: [{ UUID: "1", segment: [0, 5] }] }]
      };
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  await sandbox.fetchSegments("normVid", ["selfpromo", "sponsor", "interaction"]);
  assert.equal(fetchCount, 1);

  // Different category order should hit cache!
  const res2 = await sandbox.fetchSegments("normVid", ["interaction", "sponsor", "selfpromo"]);
  assert.equal(fetchCount, 1, "different category order should match sorted cacheKey");
  assert.equal(res2.length, 1);
});

await testAsync("fetchSegments: deduplicates concurrent in-flight requests for the same cacheKey", async () => {
  let fetchCount = 0;
  const sandbox = createIsolatedSandbox({
    fetch: async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        status: 200,
        ok: true,
        json: async () => [{ videoID: "dedupVid", segments: [{ UUID: "u1", segment: [1, 10], category: "sponsor" }] }]
      };
    }
  });
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;";
  vm.runInContext(code, sandbox);

  const [r1, r2] = await Promise.all([
    sandbox.fetchSegments("dedupVid", ["sponsor"]),
    sandbox.fetchSegments("dedupVid", ["sponsor"])
  ]);
  assert.equal(fetchCount, 1, "concurrent calls must share a single network fetch");
  assert.equal(r1.length, 1);
  assert.equal(r2.length, 1);
  assert.equal(r1[0].UUID, "u1");
});

test("setInSegmentCache: updating an existing key at capacity refreshes order without evicting another entry", () => {
  const sandbox = createIsolatedSandbox();
  vm.createContext(sandbox);
  const code = isolatedCode + "\n; globalThis.setInSegmentCache = setInSegmentCache; globalThis.segmentCache = segmentCache;";
  vm.runInContext(code, sandbox);

  for (let i = 0; i < 50; i++) {
    sandbox.setInSegmentCache(`key-${i}`, []);
  }
  assert.equal(sandbox.segmentCache.size, 50);

  // Updating an existing key (key-25) when size === 50 must NOT evict key-0
  sandbox.setInSegmentCache("key-25", [{ segment: [1, 2], UUID: "u", category: "sponsor" }]);
  assert.equal(sandbox.segmentCache.size, 50);
  assert.equal(sandbox.segmentCache.has("key-0"), true, "oldest key must not be evicted when updating an existing key");
});

console.log("\n=======================================================");
console.log("SUITE 3: popup/popup.js — DOM Null Safety & Value Validation");
console.log("=======================================================");

test("popup.js: functions execute without throwing when all DOM elements are null", () => {
  const eventListeners = {};
  const mockDoc = {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: (type, cb) => {
      eventListeners[type] = cb;
    },
    readyState: "complete"
  };

  const mockChrome = {
    storage: {
      sync: {
        get: (defaults, cb) => cb(defaults),
        set: (items, cb) => cb?.()
      }
    },
    runtime: { lastError: undefined }
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  vm.runInContext(popupCode, sandbox);

  assert.ok(true, "initialized cleanly with all null DOM elements");
});

test("popup.js: loadSettings handles corrupted storage values safely", () => {
  const testCases = [
    { desc: "null stored", data: null },
    { desc: "undefined stored", data: undefined },
    { desc: "empty object stored", data: {} },
    { desc: "corrupted non-number volumeStep", data: { volumeStep: "NaN_string" } },
    { desc: "corrupted negative volumeStep", data: { volumeStep: -50 } },
    { desc: "corrupted non-number speedStep", data: { speedStep: "fast" } },
    { desc: "corrupted non-array sponsorblockCategories", data: { sponsorblockCategories: "all" } },
    { desc: "null sponsorblockCategories", data: { sponsorblockCategories: null } },
    { desc: "corrupted non-boolean pipEnabled", data: { pipEnabled: "invalid_bool" } },
    { desc: "corrupted non-boolean pipAutoOnTabSwitch", data: { pipAutoOnTabSwitch: 9999 } }
  ];

  for (const tc of testCases) {
    const mockDoc = {
      getElementById: (id) => ({
        id,
        value: "",
        checked: false,
        textContent: "",
        style: {},
        addEventListener: () => {}
      }),
      querySelectorAll: () => [
        {
          value: "sponsor",
          checked: false,
          addEventListener: () => {}
        }
      ],
      addEventListener: () => {},
      readyState: "loading"
    };

    const mockChrome = {
      storage: {
        sync: {
          get: (defaults, cb) => {
            cb(tc.data);
          }
        }
      },
      runtime: { lastError: undefined }
    };

    const sandbox = {
      document: mockDoc,
      chrome: mockChrome,
      console: { warn: () => {}, error: () => {}, log: () => {} },
      Number: Number,
      Boolean: Boolean,
      String: String,
      Array: Array
    };
    vm.createContext(sandbox);
    const code = popupCode + "\n; globalThis.loadSettings = loadSettings;\n globalThis.cacheElements = cacheElements;";
    vm.runInContext(code, sandbox);

    sandbox.cacheElements();
    assert.doesNotThrow(() => {
      sandbox.loadSettings();
    }, `Failed on ${tc.desc}`);
  }
});

test("popup.js: volumeStep input validation rejects non-finite and out-of-range numbers", () => {
  const savedSettings = {};
  const mockChrome = {
    storage: {
      sync: {
        set: (items, cb) => {
          Object.assign(savedSettings, items);
          cb?.();
        }
      }
    },
    runtime: { lastError: undefined }
  };

  const listeners = {};
  const mockVolumeStepEl = {
    value: "5",
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    }
  };

  const mockDoc = {
    getElementById: (id) => {
      if (id === "volumeStep") return mockVolumeStepEl;
      return { style: {}, addEventListener: () => {} };
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; cacheElements(); attachListeners();";
  vm.runInContext(code, sandbox);

  assert.ok(listeners["change"], "volumeStep change listener attached");

  // Adversarial value: "invalid"
  listeners["change"]({ target: { value: "invalid" } });
  assert.equal(savedSettings.volumeStep, undefined, "invalid string not saved");

  // Out of range: 0
  listeners["change"]({ target: { value: "0" } });
  assert.equal(savedSettings.volumeStep, undefined, "0 is out of bounds [1..10]");

  // Out of range: 11
  listeners["change"]({ target: { value: "11" } });
  assert.equal(savedSettings.volumeStep, undefined, "11 is out of bounds [1..10]");

  // Valid value: 8
  listeners["change"]({ target: { value: "8" } });
  assert.equal(savedSettings.volumeStep, 8, "valid step 8 saved");
});

test("popup.js: speedStep input validation rejects <= 0 or non-finite values", () => {
  const savedSettings = {};
  const mockChrome = {
    storage: {
      sync: {
        set: (items, cb) => {
          Object.assign(savedSettings, items);
          cb?.();
        }
      }
    },
    runtime: { lastError: undefined }
  };

  const listeners = {};
  const mockSpeedStepEl = {
    value: "0.25",
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    }
  };

  const mockDoc = {
    getElementById: (id) => {
      if (id === "speedStep") return mockSpeedStepEl;
      return { style: {}, addEventListener: () => {} };
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; cacheElements(); attachListeners();";
  vm.runInContext(code, sandbox);

  assert.ok(listeners["change"], "speedStep change listener attached");

  // Adversarial value: "invalid"
  listeners["change"]({ target: { value: "invalid" } });
  assert.equal(savedSettings.speedStep, undefined);

  // Non-positive value: "-0.5"
  listeners["change"]({ target: { value: "-0.5" } });
  assert.equal(savedSettings.speedStep, undefined);

  // Zero: "0"
  listeners["change"]({ target: { value: "0" } });
  assert.equal(savedSettings.speedStep, undefined);

  // Valid value: "0.5"
  listeners["change"]({ target: { value: "0.5" } });
  assert.equal(savedSettings.speedStep, 0.5);
});

test("popup.js: pipEnabled toggle saves setting and updates pipSettings visibility", () => {
  const savedSettings = {};
  const listeners = {};
  const mockPipSettings = { style: { opacity: "1", pointerEvents: "auto" } };
  const mockPipCheckbox = {
    id: "pipEnabled",
    checked: true,
    addEventListener: (type, cb) => {
      listeners[type] = cb;
    }
  };

  const mockChrome = {
    storage: {
      sync: {
        set: (items, cb) => {
          Object.assign(savedSettings, items);
          cb?.();
        }
      }
    },
    runtime: { lastError: undefined }
  };

  const mockDoc = {
    getElementById: (id) => {
      if (id === "pipEnabled") return mockPipCheckbox;
      if (id === "pipSettings") return mockPipSettings;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; cacheElements(); attachListeners();";
  vm.runInContext(code, sandbox);

  assert.ok(listeners["change"], "pipEnabled change listener attached");

  // Toggle off
  listeners["change"]({ target: { checked: false } });
  assert.strictEqual(savedSettings.pipEnabled, false);
  assert.strictEqual(mockPipSettings.style.opacity, "0.5");
  assert.strictEqual(mockPipSettings.style.pointerEvents, "none");

  // Toggle on
  listeners["change"]({ target: { checked: true } });
  assert.strictEqual(savedSettings.pipEnabled, true);
  assert.strictEqual(mockPipSettings.style.opacity, "1");
  assert.strictEqual(mockPipSettings.style.pointerEvents, "auto");
});

test("popup.js: pipAutoOnTabSwitch toggle saves setting", () => {
  const savedSettings = {};
  const listeners = {};
  const mockCheckbox = {
    id: "pipAutoOnTabSwitch",
    checked: true,
    addEventListener: (type, cb) => {
      listeners[type] = cb;
    }
  };

  const mockChrome = {
    storage: {
      sync: {
        set: (items, cb) => {
          Object.assign(savedSettings, items);
          cb?.();
        }
      }
    },
    runtime: { lastError: undefined }
  };

  const mockDoc = {
    getElementById: (id) => (id === "pipAutoOnTabSwitch" ? mockCheckbox : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    parseInt: parseInt,
    parseFloat: parseFloat,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; cacheElements(); attachListeners();";
  vm.runInContext(code, sandbox);

  assert.ok(listeners["change"], "pipAutoOnTabSwitch change listener attached");

  listeners["change"]({ target: { checked: false } });
  assert.strictEqual(savedSettings.pipAutoOnTabSwitch, false);

  listeners["change"]({ target: { checked: true } });
  assert.strictEqual(savedSettings.pipAutoOnTabSwitch, true);
});

console.log("\n=======================================================");
console.log("SUITE 4: Cross-World postMessage Origin & Security Verification");
console.log("=======================================================");

await testAsync("content/isolated.js: rejects postMessage with mismatched origin", async () => {
  let messageHandler = null;
  const messagesSent = [];
  const mockWindow = {
    location: { origin: "https://www.youtube.com", search: "?v=testVideo123", pathname: "/watch" },
    addEventListener: (type, handler) => {
      if (type === "message") messageHandler = handler;
    },
    postMessage: (data, targetOrigin) => {
      messagesSent.push({ data, targetOrigin });
    }
  };
  mockWindow.window = mockWindow;

  const sandbox = createIsolatedSandbox({
    window: mockWindow,
    chrome: {
      storage: {
        sync: { get: async () => ({}) },
        local: { get: async () => ({}) }
      }
    }
  });
  vm.createContext(sandbox);
  vm.runInContext(isolatedCode, sandbox);

  assert.ok(messageHandler, "message handler registered");

  // Attack: Spoofed origin
  await messageHandler({
    source: mockWindow,
    origin: "https://malicious-attacker.com",
    data: { source: "yt-adjust-main", type: "REQUEST_SETTINGS" }
  });
  assert.equal(messagesSent.length, 0, "must reject mismatched origin");

  // Attack: Mismatched window source (e.g. from iframe)
  await messageHandler({
    source: { not: "window" },
    origin: "https://www.youtube.com",
    data: { source: "yt-adjust-main", type: "REQUEST_SETTINGS" }
  });
  assert.equal(messagesSent.length, 0, "must reject iframe/other window source");

  // Attack: Invalid source tag
  await messageHandler({
    source: mockWindow,
    origin: "https://www.youtube.com",
    data: { source: "youtube-native-packet", type: "REQUEST_SETTINGS" }
  });
  assert.equal(messagesSent.length, 0, "must reject non yt-adjust-main source tag");

  // Attack: Primitive data
  await messageHandler({
    source: mockWindow,
    origin: "https://www.youtube.com",
    data: "malicious-string"
  });
  assert.equal(messagesSent.length, 0, "must reject primitive data");

  // Legitimate request
  await messageHandler({
    source: mockWindow,
    origin: "https://www.youtube.com",
    data: { source: "yt-adjust-main", type: "REQUEST_SETTINGS" }
  });
  assert.equal(messagesSent.length, 1, "accepts legitimate request");
  assert.equal(messagesSent[0].targetOrigin, "https://www.youtube.com");
  assert.equal(messagesSent[0].data.source, "yt-adjust-isolated");
  assert.equal(messagesSent[0].data.type, "SETTINGS_UPDATE");
});

test("content/main.js: message listener validates origin, source, and payload", () => {
  let messageHandler = null;
  const mockWindow = {
    location: { origin: "https://www.youtube.com", pathname: "/watch", search: "?v=test" },
    addEventListener: (type, handler) => {
      if (type === "message") messageHandler = handler;
    },
    postMessage: () => {}
  };
  mockWindow.window = mockWindow;

  const mockDoc = {
    addEventListener: () => {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
    body: { appendChild: () => {} }
  };

  const sandbox = {
    window: mockWindow,
    location: mockWindow.location,
    document: mockDoc,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URLSearchParams: globalThis.URLSearchParams,
    Set: Set,
    Math: Math
  };
  vm.createContext(sandbox);
  vm.runInContext(mainCode, sandbox);

  assert.ok(messageHandler, "message handler registered in main.js");

  // 1. Spoofed origin
  assert.doesNotThrow(() => {
    messageHandler({
      source: mockWindow,
      origin: "https://evil.org",
      data: { source: "yt-adjust-isolated", type: "SETTINGS_UPDATE", payload: null }
    });
  });

  // 2. Foreign source
  assert.doesNotThrow(() => {
    messageHandler({
      source: mockWindow,
      origin: "https://www.youtube.com",
      data: { source: "other-script", type: "SETTINGS_UPDATE", payload: null }
    });
  });

  // 3. Null / primitive event.data
  assert.doesNotThrow(() => {
    messageHandler({
      source: mockWindow,
      origin: "https://www.youtube.com",
      data: null
    });
    messageHandler({
      source: mockWindow,
      origin: "https://www.youtube.com",
      data: "string-packet"
    });
  });

  // 4. SEGMENTS_UPDATE with completely corrupted payload
  assert.doesNotThrow(() => {
    messageHandler({
      source: mockWindow,
      origin: "https://www.youtube.com",
      data: {
        source: "yt-adjust-isolated",
        type: "SEGMENTS_UPDATE",
        payload: {
          videoId: 12345, // invalid type
          segments: "not-an-array" // invalid type
        }
      }
    });
  });
});

test("popup.js: applySettings clamps out-of-range values and toggleVisibility sets inert", () => {
  const elementsMap = {};
  const mockDoc = {
    getElementById: (id) => {
      if (!elementsMap[id]) {
        elementsMap[id] = {
          id,
          value: "",
          checked: false,
          textContent: "",
          inert: false,
          attrs: {},
          style: {},
          setAttribute(k, v) { this.attrs[k] = v; },
          addEventListener: () => {}
        };
      }
      return elementsMap[id];
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const mockChrome = {
    storage: {
      sync: {
        get: (defaults, cb) => cb({
          quality: "9999p_invalid",
          volumeStep: 99,
          speedStep: 7.77,
          qualityEnabled: false
        })
      }
    },
    runtime: { lastError: undefined }
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; cacheElements(); loadSettings();";
  vm.runInContext(code, sandbox);

  assert.equal(elementsMap["qualitySelect"].value, "hd1080", "invalid quality falls back to DEFAULT_SETTINGS.quality");
  assert.equal(elementsMap["volumeStep"].value, "5", "out-of-range volumeStep 99 falls back to 5");
  assert.equal(elementsMap["speedStep"].value, "0.25", "unrecognized speedStep 7.77 falls back to 0.25");
  assert.equal(elementsMap["qualitySelect"].inert, true, "disabled control sets inert = true");
  assert.equal(elementsMap["qualitySelect"].attrs["aria-disabled"], "true", "disabled control sets aria-disabled = true");
});

test("popup.js: saveSetting mirrors writes to both chrome.storage.sync and chrome.storage.local for Chrome/Helium parity", () => {
  const syncSaved = {};
  const localSaved = {};
  const mockChrome = {
    storage: {
      sync: {
        set: (items, cb) => {
          Object.assign(syncSaved, items);
          cb?.();
        }
      },
      local: {
        set: (items, cb) => {
          Object.assign(localSaved, items);
          cb?.();
        }
      }
    },
    runtime: { lastError: undefined }
  };

  const mockDoc = {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: "loading"
  };

  const sandbox = {
    document: mockDoc,
    chrome: mockChrome,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number: Number,
    Boolean: Boolean,
    String: String,
    Array: Array
  };
  vm.createContext(sandbox);
  const code = popupCode + "\n; globalThis.saveSetting = saveSetting;";
  vm.runInContext(code, sandbox);

  sandbox.saveSetting("quality", "highres");
  assert.equal(syncSaved.quality, "highres", "saved to chrome.storage.sync");
  assert.equal(localSaved.quality, "highres", "mirrored to chrome.storage.local for Helium parity");
});

test("Cross-file parity: version string (2.4.4) and default settings match across all files with zero discrepancy", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const pkgLock = JSON.parse(fs.readFileSync(path.join(rootDir, "package-lock.json"), "utf8"));
  const popupHtml = fs.readFileSync(path.join(rootDir, "popup/popup.html"), "utf8");

  assert.equal(manifest.version, "2.4.4");
  assert.equal(pkg.version, "2.4.4");
  assert.equal(pkgLock.version, "2.4.4");
  assert.ok(popupHtml.includes(`>v${manifest.version}<`), "popup.html version badge matches manifest.version");
  assert.ok(popupCode.includes(`(v${manifest.version})`), "popup.js header matches manifest.version");
  assert.ok(isolatedCode.includes(`(v${manifest.version})`), "isolated.js version matches manifest.version");
  assert.ok(mainCode.includes(`(v${manifest.version})`), "main.js version matches manifest.version");
  assert.ok(backgroundCode.includes(`(v${manifest.version})`), "background.js version matches manifest.version");

  // Extract DEFAULTS from isolated.js, DEFAULT_SETTINGS from popup.js, and state.settings from main.js
  const isoBox = createIsolatedSandbox();
  vm.createContext(isoBox);
  vm.runInContext(isolatedCode + "\n; globalThis.DEFAULTS = DEFAULTS;", isoBox);

  const popBox = {
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, readyState: "loading" },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number, Boolean, String, Array
  };
  vm.createContext(popBox);
  vm.runInContext(popupCode + "\n; globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;", popBox);

  const mainBox = {
    window: { location: { origin: "https://www.youtube.com", pathname: "/watch", search: "?v=test" }, addEventListener: () => {}, postMessage: () => {} },
    location: { origin: "https://www.youtube.com", pathname: "/watch", search: "?v=test" },
    document: { addEventListener: () => {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }), body: { appendChild: () => {} } },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    URLSearchParams, Set, Math
  };
  mainBox.window.window = mainBox.window;
  vm.createContext(mainBox);
  vm.runInContext(mainCode + "\n; globalThis.mainSettings = state.settings;", mainBox);

  assert.deepEqual(isoBox.DEFAULTS, popBox.DEFAULT_SETTINGS, "isolated.js DEFAULTS and popup.js DEFAULT_SETTINGS are identical");
  assert.deepEqual(isoBox.DEFAULTS, mainBox.mainSettings, "isolated.js DEFAULTS and main.js state.settings are identical");
  assert.equal(manifest.background?.service_worker, "background.js", "manifest.json declares background.js service worker");
});

await testAsync("MV3 Cross-Origin Isolation: fetchSegments routes via chrome.runtime.sendMessage and never calls frame fetch()", async () => {
  let frameFetchCalled = false;
  let sentMessages = [];

  // Set up background.js in its own VM context
  let bgMessageListener = null;
  const bgSandbox = {
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn) => {
            bgMessageListener = fn;
          }
        }
      }
    },
    fetch: async (url, opts) => {
      assert.ok(url.startsWith("https://sponsor.ajay.app/api/skipSegments/"), "background fetches SponsorBlock endpoint");
      assert.equal(opts.credentials, "omit", "background omits credentials");
      return {
        ok: true,
        status: 200,
        json: async () => [
          {
            videoID: "6C1l1M5Q49w",
            segments: [
              { segment: [12.5, 42.0], category: "sponsor", UUID: "sb-uuid-1" }
            ]
          }
        ]
      };
    },
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Boolean,
    String
  };
  vm.createContext(bgSandbox);
  vm.runInContext(backgroundCode + "\n; globalThis.handleSponsorBlockFetch = handleSponsorBlockFetch;", bgSandbox);
  assert.equal(typeof bgMessageListener, "function", "background.js registers chrome.runtime.onMessage listener");

  // Set up isolated.js with chrome.runtime.sendMessage wired to background.js listener
  const isoSandbox = createIsolatedSandbox({
    fetch: async () => {
      frameFetchCalled = true;
      throw new Error("Unsafe attempt to load URL from frame with URL https://www.youtube.com");
    },
    chrome: {
      runtime: {
        sendMessage: (msg) =>
          new Promise((resolve) => {
            sentMessages.push(msg);
            const asyncKeepOpen = bgMessageListener(msg, {}, resolve);
            assert.equal(asyncKeepOpen, true, "listener returns true to keep channel open");
          })
      }
    }
  });
  vm.createContext(isoSandbox);
  vm.runInContext(isolatedCode + "\n; globalThis.fetchSegments = fetchSegments;", isoSandbox);

  const segments = await isoSandbox.fetchSegments("6C1l1M5Q49w", ["sponsor", "selfpromo"]);
  assert.equal(frameFetchCalled, false, "frame-level fetch() must NEVER be called when chrome.runtime.sendMessage is available");
  assert.equal(sentMessages.length, 1, "sent 1 message to background service worker");
  assert.equal(sentMessages[0].type, "FETCH_SPONSORBLOCK");
  assert.equal(segments.length, 1, "received 1 validated segment via background service worker");
  assert.deepEqual(Array.from(segments[0].segment), [12.5, 42.0]);

  // Verify background.js rejects arbitrary non-SponsorBlock URLs
  const blockedRes = await bgSandbox.handleSponsorBlockFetch("https://evil.example.com/api");
  assert.equal(blockedRes.ok, false);
  assert.equal(blockedRes.error, "InvalidUrlError");
});

await testAsync("isolated.js getSettings: caches settings in memory across repeated calls and refreshes when forceRefresh=true", async () => {
  let syncReadCount = 0;
  let storedQuality = "hd1080";
  const sandbox = createIsolatedSandbox({
    chrome: {
      storage: {
        sync: {
          get: async () => {
            syncReadCount++;
            return { quality: storedQuality, volumeBoostLevel: 2 };
          }
        }
      }
    }
  });
  vm.createContext(sandbox);
  vm.runInContext(isolatedCode + "\n; globalThis.getSettings = getSettings;", sandbox);

  const first = await sandbox.getSettings();
  assert.equal(first.quality, "hd1080");
  assert.equal(first.volumeBoostLevel, 2);
  assert.equal(syncReadCount, 1, "first call reads from chrome.storage.sync");

  storedQuality = "highres";
  const second = await sandbox.getSettings();
  assert.equal(second.quality, "hd1080", "second call returns cached settings without hitting storage");
  assert.equal(syncReadCount, 1, "storage read count remains 1");

  const refreshed = await sandbox.getSettings(true);
  assert.equal(refreshed.quality, "highres", "forceRefresh=true reloads updated storage value");
  assert.equal(syncReadCount, 2, "storage read count increments on forceRefresh");
});

test("popup.js: volumeBoostLevel validation and resetDefaults restores DEFAULT_SETTINGS across sync, local, and localStorage", () => {
  let syncSaved = {};
  let localSaved = {};
  let localStore = {};

  const elementsMap = {
    qualityEnabled: { checked: false, style: {}, addEventListener: () => {} },
    qualitySelect: { value: "large", style: {}, addEventListener: () => {} },
    volumeBoostEnabled: { checked: false, style: {}, addEventListener: () => {} },
    volumeBoostLevel: { value: "3", style: {}, addEventListener: () => {} },
    resetDefaultsBtn: { addEventListener: () => {} }
  };

  const sandbox = {
    document: {
      getElementById: (id) => elementsMap[id] || null,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: () => {},
      readyState: "loading"
    },
    localStorage: {
      getItem: (k) => localStore[k] || null,
      setItem: (k, v) => { localStore[k] = v; }
    },
    chrome: {
      storage: {
        sync: {
          set: (items, cb) => { Object.assign(syncSaved, items); cb?.(); }
        },
        local: {
          set: (items, cb) => { Object.assign(localSaved, items); cb?.(); }
        }
      },
      runtime: { lastError: undefined }
    },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    Number, Boolean, String, Array
  };
  vm.createContext(sandbox);
  vm.runInContext(
    popupCode + "\n; globalThis.cacheElements = cacheElements; globalThis.applySettings = applySettings; globalThis.resetDefaults = resetDefaults; globalThis.DEFAULT_SETTINGS = DEFAULT_SETTINGS;",
    sandbox
  );

  sandbox.cacheElements();
  // Apply invalid volumeBoostLevel (99) -> falls back to 1.5
  sandbox.applySettings({ ...sandbox.DEFAULT_SETTINGS, volumeBoostLevel: 99, quality: "large" });
  assert.equal(elementsMap.volumeBoostLevel.value, "1.5", "invalid volumeBoostLevel falls back to 1.5");

  // Apply valid volumeBoostLevel (3) -> sets "3"
  sandbox.applySettings({ ...sandbox.DEFAULT_SETTINGS, volumeBoostLevel: 3, quality: "large", qualityEnabled: false });
  assert.equal(elementsMap.volumeBoostLevel.value, "3", "valid volumeBoostLevel (300%) applied");
  assert.equal(elementsMap.qualitySelect.value, "large");

  // Trigger resetDefaults()
  sandbox.resetDefaults();
  assert.equal(elementsMap.qualitySelect.value, "hd1080", "resetDefaults restores qualitySelect to hd1080");
  assert.equal(elementsMap.qualityEnabled.checked, true, "resetDefaults restores qualityEnabled to true");
  assert.equal(elementsMap.volumeBoostLevel.value, "1.5", "resetDefaults restores volumeBoostLevel to 1.5");
  assert.equal(syncSaved.quality, "hd1080", "resetDefaults persists defaults to chrome.storage.sync");
  assert.equal(localSaved.volumeBoostLevel, 1.5, "resetDefaults persists defaults to chrome.storage.local");
});

console.log("\n=======================================================");
console.log(`STRESS TEST SUMMARY: ${passedTests}/${totalTests} tests passed (${failedTests} failures)`);
console.log("=======================================================\n");

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
