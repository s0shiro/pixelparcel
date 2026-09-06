"use strict";

const activeWatches = new Map();
const mediaTypeCache = new Map();
const WATCH_MAX_AGE_MS = 12 * 60 * 1000;
const WATCH_STORAGE_KEY = "flowDownloadWatches";
let watchesLoaded = false;
let watchQueue = Promise.resolve();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flowOrigin(value) {
  try {
    const url = new URL(value);
    return ["https://labs.google", "https://flow.google.com"].includes(url.origin) ? url.origin : "";
  } catch {
    return "";
  }
}

function withWatches(action) {
  const task = watchQueue.then(async () => {
    if (!watchesLoaded) {
      const saved = await chrome.storage.session.get(WATCH_STORAGE_KEY);
      for (const [tabId, watch] of saved[WATCH_STORAGE_KEY] || []) activeWatches.set(tabId, watch);
      watchesLoaded = true;
    }
    expireOldWatches();
    const result = await action();
    await chrome.storage.session.set({ [WATCH_STORAGE_KEY]: [...activeWatches] });
    return result;
  });
  watchQueue = task.catch(() => undefined);
  return task;
}

async function fetchProjectInventory(projectId) {
  if (!UUID.test(projectId)) throw new Error("Flow project ID is invalid.");
  const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
  let response;
  try {
    response = await fetch(`https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`, {
      credentials: "include",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Legacy Flow project request could not connect. Check site access, your connection, and that Flow is signed in.");
  }
  if (!response.ok) throw new Error(`Legacy Flow project request returned HTTP ${response.status}. Refresh Flow and sign in again if needed.`);
  try {
    const payload = await response.json();
    if (payload?.error) throw new Error("RPC error");
    return payload;
  } catch {
    throw new Error("Legacy Flow did not return project data. The endpoint or sign-in session may have changed.");
  }
}

function mediaDownloadUrl(mediaId) {
  return `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${encodeURIComponent(mediaId)}`;
}

function typeFromMediaResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const finalUrl = response.url || "";
  if (/video/i.test(contentType) || /\/video\//i.test(finalUrl)) return "video";
  if (/image/i.test(contentType) || /\/image\//i.test(finalUrl)) return "image";
  return "unknown";
}

async function classifyMediaId(mediaId) {
  if (mediaTypeCache.has(mediaId)) return mediaTypeCache.get(mediaId);

  let response;
  try {
    response = await fetch(mediaDownloadUrl(mediaId), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(20_000),
    });
    const type = response.ok ? typeFromMediaResponse(response) : "unknown";
    await response.body?.cancel().catch(() => undefined);
    if (type !== "unknown") mediaTypeCache.set(mediaId, type);
    return type;
  } catch {
    await response?.body?.cancel().catch(() => undefined);
    return "unknown";
  }
}

async function classifyMediaIds(mediaIds) {
  const types = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(6, mediaIds.length) }, async () => {
    while (cursor < mediaIds.length) {
      const index = cursor;
      cursor += 1;
      const mediaId = mediaIds[index];
      types[mediaId] = await classifyMediaId(mediaId);
    }
  });
  await Promise.all(workers);
  return types;
}

function looksLikeVideoDownload(item) {
  const combined = [item.url, item.finalUrl, item.filename, item.mime, item.referrer]
    .filter(Boolean)
    .join(" ");
  return /(?:video\/|\.mp4(?:\?|$)|\.webm(?:\?|$)|\.mov(?:\?|$)|flow-content\.google|googlevideo\.com)/i
    .test(combined);
}

function expireOldWatches() {
  const now = Date.now();
  for (const [tabId, watch] of activeWatches) {
    if (now - watch.startedAt > WATCH_MAX_AGE_MS) activeWatches.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type?.startsWith("FLOW_")) return false;
  const origin = flowOrigin(sender.url || sender.tab?.url);
  if (!origin || !Number.isInteger(sender.tab?.id)) {
    sendResponse({ ok: false, error: "This request must come from an open Google Flow tab." });
    return false;
  }

  const respond = (promise) => {
    promise.then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  };

  if (message.type === "FLOW_FETCH_PROJECT") {
    if (origin !== "https://labs.google") {
      sendResponse({ ok: false, error: "The new Flow app uses its media grid, not the legacy inventory API." });
      return false;
    }
    return respond(fetchProjectInventory(message.projectId).then((payload) => ({ ok: true, payload })));
  }

  if (message.type === "FLOW_DOWNLOAD_STATUS") {
    return respond((async () => {
      if (!Number.isInteger(message.downloadId)) throw new Error("Invalid download ID.");
      const [item] = await chrome.downloads.search({ id: message.downloadId });
      if (!item || item.byExtensionId !== chrome.runtime.id) throw new Error("The extension's download could not be found in Chrome Downloads.");
      return { ok: true, state: item.state, error: item.error || "" };
    })());
  }

  if (message?.type === "FLOW_WATCH_DOWNLOAD") {
    const tabId = sender.tab?.id;
    return respond(withWatches(() => {
      if ([...activeWatches.keys()].some((id) => id !== tabId)) {
        throw new Error("An export is already being monitored in another Flow tab. Finish or stop that job first.");
      }
      activeWatches.set(tabId, { token: message.token, origin, startedAt: Date.now() });
      return { ok: true };
    }));
  }

  if (message?.type === "FLOW_CANCEL_DOWNLOAD_WATCH") {
    const tabId = sender.tab?.id;
    return respond(withWatches(() => {
      const watch = activeWatches.get(tabId);
      if (!message.token || watch?.token === message.token) activeWatches.delete(tabId);
      return { ok: true };
    }));
  }

  if (message?.type === "FLOW_DIRECT_DOWNLOAD") {
    const options = {
      url: message.url,
      filename: message.filename,
      conflictAction: "uniquify",
      saveAs: false,
    };
    chrome.downloads.download(options)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "FLOW_DOWNLOAD_MEDIA") {
    if (origin !== "https://labs.google" || !UUID.test(message.mediaId)) {
      sendResponse({ ok: false, error: "This video must be downloaded through its Flow menu." });
      return false;
    }
    chrome.downloads.download({
      url: mediaDownloadUrl(message.mediaId),
      filename: message.filename,
      conflictAction: "uniquify",
      saveAs: false,
    })
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "FLOW_CLASSIFY_MEDIA_IDS") {
    const mediaIds = [...new Set(message.mediaIds || [])]
      .filter((value) => typeof value === "string" && UUID.test(value))
      .slice(0, 1000);
    classifyMediaIds(mediaIds)
      .then((types) => sendResponse({ ok: true, types }))
      .catch((error) => sendResponse({ ok: false, error: error.message, types: {} }));
    return true;
  }

  return false;
});

async function finishWatchedDownload(tabId, watch, item) {
  if (item.state !== "complete" && item.state !== "interrupted") return;
  activeWatches.delete(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: item.state === "complete" ? "FLOW_DOWNLOAD_DETECTED" : "FLOW_DOWNLOAD_FAILED",
    token: watch.token,
    downloadId: item.id,
    filename: item.filename || "",
    error: item.state === "interrupted" ? `Chrome download failed: ${item.error || "interrupted"}. Retry this video.` : "",
  }).catch(() => undefined);
}

chrome.downloads.onCreated.addListener((item) => {
  // Flow's Angular downloader creates blob URLs on its own origin. Ignore
  // unrelated browser downloads and direct downloads started by this extension.
  if (item.byExtensionId) return;
  void withWatches(async () => {
    for (const [tabId, watch] of activeWatches) {
      if (watch.downloadId !== undefined) continue;
      const sameOrigin = flowOrigin(item.url) === watch.origin || flowOrigin(item.referrer) === watch.origin;
      if (!sameOrigin || (item.mime && !/^video\//i.test(item.mime)
        && item.mime !== "application/octet-stream")) continue;
      if (!item.url?.startsWith("blob:") && !looksLikeVideoDownload(item)) continue;
      watch.downloadId = item.id;
      const [latest] = await chrome.downloads.search({ id: item.id });
      await finishWatchedDownload(tabId, watch, latest || item);
      break;
    }
  }).catch(() => undefined);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!["complete", "interrupted"].includes(delta.state?.current)) return;
  void withWatches(async () => {
    for (const [tabId, watch] of activeWatches) {
      if (watch.downloadId !== delta.id) continue;
      const [item] = await chrome.downloads.search({ id: delta.id });
      await finishWatchedDownload(tabId, watch, item || {
        id: delta.id, state: delta.state.current, error: delta.error?.current,
      });
    }
  }).catch(() => undefined);
});
