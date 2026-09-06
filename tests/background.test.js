"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");
const legacySender = { url: "https://labs.google/fx/tools/flow/project/test", tab: { id: 42 } };
const modernSender = { url: "https://flow.google.com/project/test", tab: { id: 42 } };
const projectId = "11111111-1111-4111-8111-111111111111";

function worker({ fetch = async () => { throw new Error("Unexpected fetch"); }, storage = {} } = {}) {
  const listeners = {};
  const sent = [];
  const notifications = [];
  const downloads = new Map();
  const context = vm.createContext({
    URL, AbortSignal, fetch,
    chrome: {
      runtime: { id: "exporter", onMessage: { addListener: (fn) => { listeners.message = fn; } } },
      storage: {
        session: {
          async get(key) { return { [key]: structuredClone(storage[key]) }; },
          async set(values) { Object.assign(storage, structuredClone(values)); },
        },
        local: {
          async get(key) { return { [key]: structuredClone(storage[key]) }; },
          async set(values) { Object.assign(storage, structuredClone(values)); },
        },
      },
      notifications: {
        create(options, callback) {
          notifications.push(options);
          callback?.("notif-1");
        },
      },
      tabs: { async sendMessage(tabId, message) { sent.push({ tabId, ...message }); } },
      downloads: {
        async download() { return 10; },
        async search(query = {}) {
          let list = [...downloads.values()];
          if (query.id !== undefined) list = list.filter((d) => d.id === query.id);
          if (query.state !== undefined) list = list.filter((d) => d.state === query.state);
          return list;
        },
        onCreated: { addListener: (fn) => { listeners.created = fn; } },
        onChanged: { addListener: (fn) => { listeners.changed = fn; } },
        onDeterminingFilename: { addListener: (fn) => { listeners.determiningFilename = fn; } },
      },
    },
  });
  vm.runInContext(source, context);
  return {
    sent, downloads, storage, notifications, listeners,
    send(message, sender = modernSender) {
      return new Promise((resolve) => {
        const async = listeners.message(message, sender, resolve);
        if (!async) resolve(undefined);
      });
    },
    async create(item) { downloads.set(item.id, item); listeners.created(item); await new Promise(setImmediate); },
    async change(id, state, error) {
      downloads.set(id, { ...downloads.get(id), id, state, error });
      listeners.changed({ id, state: { current: state }, error: { current: error } });
      await new Promise(setImmediate);
    },
  };
}

test("legacy inventory fetch runs in the worker with credentials and a fixed endpoint", async () => {
  let request;
  const w = worker({ fetch: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ result: { data: { workflows: [] } } }) };
  } });
  const result = await w.send({ type: "FLOW_FETCH_PROJECT", projectId }, legacySender);
  assert.equal(result.ok, true);
  assert.equal(new URL(request.url).origin, "https://labs.google");
  assert.equal(new URL(request.url).pathname, "/fx/api/trpc/flow.projectInitialData");
  assert.equal(request.options.credentials, "include");
  assert.ok(request.options.signal);
});

test("new Flow never calls the legacy inventory or media redirect endpoints", async () => {
  const w = worker();
  assert.equal((await w.send({ type: "FLOW_FETCH_PROJECT", projectId })).ok, false);
  assert.equal((await w.send({ type: "FLOW_DOWNLOAD_MEDIA", mediaId: projectId })).ok, false);
  assert.equal((await w.send({ type: "FLOW_FETCH_PROJECT", projectId: "https://example.com" }, legacySender)).ok, false);
});

test("network and sign-in failures provide actionable errors", async () => {
  for (const fetch of [async () => { throw new TypeError("Failed to fetch"); }, async () => ({ ok: false, status: 401 })]) {
    const result = await worker({ fetch }).send({ type: "FLOW_FETCH_PROJECT", projectId }, legacySender);
    assert.equal(result.ok, false);
    assert.match(result.error, /Legacy Flow project request/);
    assert.notEqual(result.error, "Failed to fetch");
  }
});

test("unrelated browser downloads do not complete a Flow export", async () => {
  const w = worker();
  assert.equal((await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "video-1" })).ok, true);
  await w.create({ id: 1, url: "https://example.com/movie.mp4", mime: "video/mp4", state: "complete" });
  assert.equal(w.sent.length, 0);
});

test("native Flow downloads are successful only after Chrome reports completion", async () => {
  const w = worker();
  await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "video-1" });
  await w.create({ id: 1, url: "blob:https://flow.google.com/video-1", mime: "video/mp4", state: "in_progress" });
  assert.equal(w.sent.length, 0);
  await w.change(1, "complete");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].type, "FLOW_DOWNLOAD_DETECTED");
  assert.equal(w.sent[0].token, "video-1");
});

test("failed downloads retain their token and report Chrome's interruption reason", async () => {
  const w = worker();
  await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "video-2" });
  await w.create({ id: 2, url: "blob:https://flow.google.com/video-2", state: "in_progress" });
  await w.change(2, "interrupted", "NETWORK_FAILED");
  assert.equal(w.sent[0].type, "FLOW_DOWNLOAD_FAILED");
  assert.equal(w.sent[0].token, "video-2");
  assert.match(w.sent[0].error, /NETWORK_FAILED/);
});

test("native download tracking survives a service-worker restart", async () => {
  const storage = {};
  const first = worker({ storage });
  await first.send({ type: "FLOW_WATCH_DOWNLOAD", token: "long-upscale" });
  const next = worker({ storage });
  await next.create({ id: 3, url: "blob:https://flow.google.com/upscale", state: "in_progress" });
  const last = worker({ storage });
  await last.change(3, "complete");
  assert.equal(last.sent[0].token, "long-upscale");
});

test("simultaneous native exports cannot claim each other's downloads", async () => {
  const w = worker();
  await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "first" });
  const result = await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "second" }, { ...modernSender, tab: { id: 43 } });
  assert.equal(result.ok, false);
  assert.match(result.error, /another Flow tab/);
  await w.send({ type: "FLOW_CANCEL_DOWNLOAD_WATCH", token: "first" });
  assert.equal((await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "second" }, { ...modernSender, tab: { id: 43 } })).ok, true);
});

test("direct downloads expose completion and interruption, not just an ID", async () => {
  const w = worker();
  w.downloads.set(10, { id: 10, state: "interrupted", error: "SERVER_FORBIDDEN", byExtensionId: "exporter" });
  const result = await w.send({ type: "FLOW_DOWNLOAD_STATUS", downloadId: 10 });
  assert.equal(result.state, "interrupted");
  assert.equal(result.error, "SERVER_FORBIDDEN");
});

test("check download watch detects completed download via polling", async () => {
  const w = worker();
  await w.send({ type: "FLOW_WATCH_DOWNLOAD", token: "poll-token" });
  w.downloads.set(5, {
    id: 5,
    url: "blob:https://flow.google.com/upscaled-video",
    state: "complete",
    startTime: new Date().toISOString(),
  });
  const check = await w.send({ type: "FLOW_CHECK_DOWNLOAD_WATCH", token: "poll-token" });
  assert.equal(check.ok, true);
  assert.equal(check.matched, true);
  assert.equal(check.state, "complete");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].type, "FLOW_DOWNLOAD_DETECTED");
  assert.equal(w.sent[0].token, "poll-token");
});

test("returns completed download history for deduplication", async () => {
  const w = worker();
  w.downloads.set(1, { id: 1, state: "complete", filename: "/home/user/Downloads/EP01_Scene1.mp4" });
  w.downloads.set(2, { id: 2, state: "interrupted", filename: "/home/user/Downloads/EP02_Failed.mp4" });
  const result = await w.send({ type: "FLOW_GET_DOWNLOAD_HISTORY" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.filenames, ["EP01_Scene1.mp4"]);
});

test("triggers desktop notification on completion", async () => {
  const w = worker();
  const res = await w.send({
    type: "FLOW_NOTIFY_COMPLETION",
    title: "Flow Export Complete",
    message: "16 downloaded, 0 failed.",
  });
  assert.equal(res.ok, true);
  assert.equal(w.notifications.length, 1);
  assert.equal(w.notifications[0].title, "Flow Export Complete");
  assert.equal(w.notifications[0].message, "16 downloaded, 0 failed.");
});

test("routes downloads to Flow project subfolder when determining filename", async () => {
  const w = worker();
  await w.send({
    type: "FLOW_WATCH_DOWNLOAD",
    token: "token-folder",
    subfolder: "Korean_Drama_EP02",
  });
  let suggested = null;
  w.listeners.determiningFilename(
    { id: 99, url: "blob:https://flow.google.com/test", filename: "Shot1.mp4" },
    (result) => { suggested = result; },
  );
  await new Promise(setImmediate);
  assert.ok(suggested);
  assert.equal(suggested.filename, "Flow/Korean_Drama_EP02/Shot1.mp4");
  assert.equal(suggested.conflictAction, "uniquify");
});

test("routes downloads to custom subfolder path when isCustom is true", async () => {
  const w = worker();
  await w.send({
    type: "FLOW_WATCH_DOWNLOAD",
    token: "token-custom",
    subfolder: "MyDrama/Episodes",
    isCustom: true,
  });
  let suggested = null;
  w.listeners.determiningFilename(
    { id: 101, url: "blob:https://flow.google.com/test", filename: "Shot2.mp4" },
    (result) => { suggested = result; },
  );
  await new Promise(setImmediate);
  assert.ok(suggested);
  assert.equal(suggested.filename, "MyDrama/Episodes/Shot2.mp4");
  assert.equal(suggested.conflictAction, "uniquify");
});
