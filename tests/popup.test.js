"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const source = (name) => fs.readFileSync(path.join(extensionDir, name), "utf8");

function element() {
  const classes = new Set();
  return {
    textContent: "",
    disabled: false,
    hidden: false,
    style: {},
    listeners: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    replaceChildren() {},
    append() {},
  };
}

async function openPopup(tab, options = {}) {
  const elements = new Map();
  const messages = [];
  const queries = [];
  let poll;
  let clipboardText = null;
  const model = { tab, connected: true, queryError: null, ...options };
  const context = vm.createContext({
    URL,
    setTimeout,
    clearTimeout,
    navigator: {
      clipboard: {
        async writeText(text) { clipboardText = text; },
      },
    },
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
      },
      createElement: element,
    },
    chrome: {
      tabs: {
        async query(query) {
          queries.push(query);
          if (model.queryError) throw new Error(model.queryError);
          return model.tab ? [model.tab] : [];
        },
        async sendMessage(tabId, message) {
          messages.push({ tabId, ...message });
          if (!model.connected) throw new Error("Receiving end does not exist.");
          if (message?.type === "FLOW_GET_SELECTION" && model.selection) {
            return { ok: true, selectedMediaIds: model.selection };
          }
          return model.status || { running: false, found: 23, failures: [], mode: "Idle" };
        },
      },
      storage: {
        local: {
          async get() {
            return model.storage || {};
          },
          async set(values) {
            model.storage = { ...model.storage, ...values };
          },
        },
      },
    },
    setInterval(callback) { poll = callback; },
  });
  vm.runInContext(source("core.js"), context);
  vm.runInContext(source("popup.js"), context);
  await new Promise(setImmediate);
  return {
    model, messages, queries,
    get: (selector) => elements.get(selector),
    getClipboard: () => clipboardText,
    async refresh() {
      assert.equal(typeof poll, "function", "Keep checking even after an initial detection failure");
      await poll();
    },
  };
}

test("detects Flow on both hosts and sends actions only to the selected tab", async () => {
  for (const url of [
    "https://labs.google/fx/tools/flow/project/example",
    "https://labs.google/fx/flow/project/example",
    "https://labs.google/fx/en/tools/flow/project/example",
    "https://flow.google.com/project/example",
  ]) {
    const popup = await openPopup({ id: 42, url });
    assert.equal(popup.get("#page-status").textContent, "Current Flow project detected", url);
    assert.equal(popup.get("#scan-button").disabled, false, url);
    assert.equal(popup.get("#found-count").textContent, 23);
    await popup.get("#scan-button").listeners.click();
    assert.ok(popup.messages.some((message) => message.type === "FLOW_SCAN_PROJECT"));
    assert.ok(popup.messages.every((message) => message.tabId === 42));
    assert.ok(popup.queries.every((query) => query.active && query.lastFocusedWindow));
  }
});

test("uses a pending Flow URL while a tab is loading", async () => {
  const popup = await openPopup({ id: 42, url: "about:blank", pendingUrl: "https://flow.google.com/project/example" });
  assert.equal(popup.get("#scan-button").disabled, false);
});

test("distinguishes an unreadable tab URL from a non-Flow page", async () => {
  const popup = await openPopup({ id: 42 });
  assert.match(popup.get("#page-status").textContent, /cannot read.*tab.*address/i);
  assert.equal(popup.get("#scan-button").disabled, true);
  assert.equal(popup.messages.length, 0);
});

test("does not select another project when the active tab is not Flow", async () => {
  for (const url of ["https://example.com/flow", "https://labs.google/fx/tools/flower", "https://flow.google.com.example.com/"]) {
    const popup = await openPopup({ id: 42, url });
    assert.match(popup.get("#page-status").textContent, /select.*flow project tab/i);
    assert.equal(popup.get("#scan-button").disabled, true);
    assert.equal(popup.messages.length, 0);
    assert.equal(popup.queries.length, 1);
  }
});

test("rechecks detection after an initially unavailable tab", async () => {
  const popup = await openPopup(null);
  assert.equal(popup.get("#scan-button").disabled, true);
  popup.model.tab = { id: 42, url: "https://flow.google.com/project/example" };
  await popup.refresh();
  assert.equal(popup.get("#scan-button").disabled, false);
  assert.equal(popup.get("#page-status").classList.contains("error"), false);
});

test("shows a connection error and clears it after the content script reconnects", async () => {
  const popup = await openPopup({ id: 42, url: "https://labs.google/fx/tools/flow/project/example" }, { connected: false });
  assert.match(popup.get("#page-status").textContent, /Flow detected.*reload the Flow tab/i);
  assert.equal(popup.get("#scan-button").disabled, true);
  popup.model.connected = true;
  await popup.refresh();
  assert.equal(popup.get("#page-status").textContent, "Current Flow project detected");
  assert.equal(popup.get("#page-status").classList.contains("error"), false);
  assert.equal(popup.get("#scan-button").disabled, false);
});

test("reports tab-query errors without leaving the popup stuck checking", async () => {
  const popup = await openPopup(null, { queryError: "Tab access unavailable" });
  assert.match(popup.get("#page-status").textContent, /Tab access unavailable/);
  assert.equal(popup.get("#scan-button").disabled, true);
  popup.model.queryError = null;
  popup.model.tab = { id: 42, url: "https://flow.google.com/" };
  await popup.refresh();
  assert.equal(popup.get("#scan-button").disabled, false);
});

test("copies diagnostic logs to clipboard with failure details and activity logs", async () => {
  const popup = await openPopup(
    { id: 42, url: "https://flow.google.com/project/example" },
    {
      status: {
        running: false,
        mode: "Idle",
        message: "Finished — 21 downloaded, 2 failed",
        found: 30,
        processed: 23,
        success: 21,
        failed: 2,
        lastError: "1080p is not available for this video or account.",
        failures: [
          { index: 9, title: "12_02-RH-12-BUNG_SH-02_V2_POV_WALKIN.mp4", error: "Flow menu timed out" },
          { index: 10, title: "18_01-RH-09-BUNG_SH-02_V3_TRUCK_LEFT.mp4", error: "1080p is not available" },
        ],
        logs: [
          "[19:35:01] Starting batch export (1080p)...",
          "[19:35:10] [#1] Export completed.",
        ],
      },
    },
  );

  const copyButton = popup.get("#copy-logs-button");
  assert.ok(copyButton);
  await copyButton.listeners.click();
  assert.equal(copyButton.textContent, "✓ Logs copied!");
  assert.ok(copyButton.classList.contains("copied"));

  const copied = popup.getClipboard();
  assert.ok(copied.includes("=== PIXELPARCEL DIAGNOSTIC LOGS ==="));
  assert.ok(copied.includes("30 found | 21 downloaded | 2 failed"));
  assert.ok(copied.includes("#9 — 12_02-RH-12-BUNG_SH-02_V2_POV_WALKIN.mp4: Flow menu timed out"));
  assert.ok(copied.includes("#10 — 18_01-RH-09-BUNG_SH-02_V3_TRUCK_LEFT.mp4: 1080p is not available"));
  assert.ok(copied.includes("[19:35:01] Starting batch export (1080p)..."));
});

test("manifest grants click access and injects on every supported Flow route", () => {
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("notifications"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(manifest.side_panel?.default_path, "popup.html");
  assert.equal(manifest.action?.default_popup, undefined);
  assert.ok(manifest.host_permissions.includes("https://flow.google.com/*"));
  const matches = manifest.content_scripts.flatMap((script) => script.matches);
  for (const url of [
    "https://flow.google.com/project/example",
    "https://labs.google/fx/tools/flow",
    "https://labs.google/fx/flow/project/example",
    "https://labs.google/fx/en/tools/flow/project/example",
    "https://labs.google/fx/pt-BR/flow/project/example",
  ]) {
    assert.ok(matches.some((pattern) => {
      const regex = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp(`^${regex}$`).test(url);
    }), url);
  }
  assert.match(source("popup.html"), /<script src="core.js"><\/script>\s*<script src="popup.js"><\/script>/);
});

test("download-history skipping and popup filtering are absent from the extension", () => {
  for (const filename of ["popup.html", "popup.js", "content.js", "background.js"]) {
    assert.doesNotMatch(source(filename), /skipDownloaded|FLOW_GET_DOWNLOAD_HISTORY|opt-skip|skipped-count|filter-input|matchesFilter|message\.filter/);
  }
});

test("popup displays live timing statistics and passes folder options in batch requests", async () => {
  const popup = await openPopup(
    { id: 42, url: "https://flow.google.com/project/example" },
    {
      status: {
        running: true,
        mode: "1080p upscale",
        message: "1080p: processing video 2/10…",
        found: 10,
        processed: 2,
        success: 2,
        failed: 0,
        elapsed: "01:15",
        eta: "04:30",
        speed: "35s/item",
        failures: [],
      },
    },
  );

  assert.equal(popup.get("#elapsed-time").textContent, "01:15");
  assert.equal(popup.get("#eta-time").textContent, "04:30");
  assert.equal(popup.get("#speed-stat").textContent, "35s/item");

  // Set custom folder
  popup.get("#custom-folder-input").value = "Drama/Season1";
  await popup.get("#custom-folder-input").listeners.input();
  assert.equal(popup.model.storage?.customFolder, "Drama/Season1");
  assert.equal(popup.get("#folder-preview").textContent, "Location: Downloads/Drama/Season1/");

  await popup.get("#download-1080-button").listeners.click();

  const batchMsg = popup.messages.find((m) => m.type === "FLOW_START_BATCH");
  assert.ok(batchMsg);
  assert.equal(batchMsg.quality, "1080p");
  assert.equal(batchMsg.customFolder, "Drama/Season1");
  assert.equal(batchMsg.organizeSubfolders, true);
  assert.equal(batchMsg.soundNotifications, true);

  // Reset custom folder
  await popup.get("#custom-folder-reset").listeners.click();
  assert.equal(popup.get("#custom-folder-input").value, "");
  assert.equal(popup.model.storage?.customFolder, "");
  assert.equal(popup.get("#folder-preview").textContent, "Location: Downloads/Flow Videos/");
});

test("folder controls show the exact destination and support direct Downloads", async () => {
  const popup = await openPopup(
    { id: 42, url: "https://flow.google.com/project/example" },
    { storage: { organizeSubfolders: false, customFolder: "Old/Nested/Folder" } },
  );

  assert.equal(popup.get("#custom-folder-input").disabled, true);
  assert.equal(popup.get("#custom-folder-reset").disabled, true);
  assert.equal(popup.get("#folder-preview").textContent, "Location: Downloads/ (no export folder)");

  popup.get("#opt-subfolders").checked = true;
  await popup.get("#opt-subfolders").listeners.change();
  assert.equal(popup.get("#custom-folder-input").disabled, false);
  assert.equal(popup.get("#folder-preview").textContent, "Location: Downloads/Old/Nested/Folder/");
});

test("popup synchronizes in-page selection and passes selectedMediaIds in batch", async () => {
  const popup = await openPopup(
    { id: 42, url: "https://flow.google.com/project/example" },
    {
      selection: ["media-1", "media-2"],
      status: {
        running: false,
        mode: "Idle",
        found: 10,
        failures: [],
      },
    },
  );

  await popup.refresh();

  assert.equal(popup.get("#selection-notice").hidden, false);
  assert.equal(popup.get("#selection-text").textContent, "2 videos selected in grid");

  await popup.get("#download-720-button").listeners.click();
  const batchMsg = popup.messages.find((m) => m.type === "FLOW_START_BATCH" && m.quality === "720p");
  assert.ok(batchMsg);
  assert.deepEqual(batchMsg.selectedMediaIds, ["media-1", "media-2"]);

  // Clear selection
  await popup.get("#selection-clear-btn").listeners.click();
  const clearMsg = popup.messages.find((m) => m.type === "FLOW_CLEAR_SELECTION");
  assert.ok(clearMsg);
  assert.equal(popup.get("#selection-notice").hidden, true);
});
