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
  const model = { tab, connected: true, queryError: null, ...options };
  const context = vm.createContext({
    URL,
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
          return { running: false, found: 23, failures: [], mode: "Idle" };
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

test("manifest grants click access and injects on every supported Flow route", () => {
  assert.ok(manifest.permissions.includes("activeTab"));
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
