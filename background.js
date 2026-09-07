"use strict";

function enableActionSidePanel() {
  try {
    const request = chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    void Promise.resolve(request).catch(() => undefined);
  } catch {}
}

enableActionSidePanel();
chrome.runtime.onInstalled?.addListener(enableActionSidePanel);
chrome.runtime.onStartup?.addListener(enableActionSidePanel);

const activeWatches = new Map();
const recentDownloadRoutes = new Map();
const mediaTypeCache = new Map();
const WATCH_MAX_AGE_MS = 12 * 60 * 1000;
const DOWNLOAD_ROUTE_MAX_AGE_MS = 5 * 60 * 1000;
const WATCH_STORAGE_KEY = "flowDownloadWatches";
const DOWNLOAD_ROUTE_STORAGE_KEY = "flowDownloadRoutes";
let watchesLoaded = false;
let watchQueue = Promise.resolve();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flowOrigin(value) {
  try {
    const url = new URL(value);
    if (["https://labs.google", "https://flow.google.com"].includes(url.origin)) return url.origin;
    if (url.hostname.endsWith(".google.com") || url.hostname.endsWith(".googleapis.com") || url.hostname.endsWith(".googleusercontent.com")) {
      return "google";
    }
    return "";
  } catch {
    return "";
  }
}

function withWatches(action) {
  const task = watchQueue.then(async () => {
    if (!watchesLoaded) {
      const saved = await chrome.storage.session.get(WATCH_STORAGE_KEY);
      for (const [tabId, watch] of saved[WATCH_STORAGE_KEY] || []) activeWatches.set(tabId, watch);
      const savedRoutes = await chrome.storage.session.get(DOWNLOAD_ROUTE_STORAGE_KEY);
      for (const [downloadId, route] of savedRoutes[DOWNLOAD_ROUTE_STORAGE_KEY] || []) {
        recentDownloadRoutes.set(downloadId, route);
      }
      watchesLoaded = true;
    }
    expireOldWatches();
    const result = await action();
    await chrome.storage.session.set({
      [WATCH_STORAGE_KEY]: [...activeWatches],
      [DOWNLOAD_ROUTE_STORAGE_KEY]: [...recentDownloadRoutes],
    });
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
  for (const [downloadId, route] of recentDownloadRoutes) {
    if (now - route.rememberedAt > DOWNLOAD_ROUTE_MAX_AGE_MS) recentDownloadRoutes.delete(downloadId);
  }
}

function rememberDownloadRoute(watch, downloadId) {
  if (!Number.isInteger(downloadId)) return;
  recentDownloadRoutes.set(downloadId, {
    subfolder: watch.subfolder || "",
    rememberedAt: Date.now(),
  });
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
    return respond(withWatches(async () => {
      if ([...activeWatches.keys()].some((id) => id !== tabId)) {
        throw new Error("An export is already being monitored in another Flow tab. Finish or stop that job first.");
      }
      const existingDownloads = await chrome.downloads.search({
        limit: 100,
        orderBy: ["-startTime"],
      }).catch(() => []);
      activeWatches.set(tabId, {
        token: message.token,
        origin,
        startedAt: Date.now(),
        subfolder: message.subfolder || "",
        baselineDownloadIds: existingDownloads.map((item) => item.id).filter(Number.isInteger),
      });
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

  if (message?.type === "FLOW_CHECK_DOWNLOAD_WATCH") {
    const tabId = sender.tab?.id;
    return respond(withWatches(async () => {
      const watch = activeWatches.get(tabId);
      if (!watch || watch.token !== message.token) return { ok: true, active: false };
      const recent = await chrome.downloads.search({
        limit: 10,
        orderBy: ["-startTime"],
      });
      for (const item of recent) {
        if (item.byExtensionId) continue;
        if (watch.downloadId !== undefined && item.id !== watch.downloadId) continue;
        if (watch.downloadId === undefined && watch.baselineDownloadIds?.includes(item.id)) continue;
        const itemTime = new Date(item.startTime || 0).getTime();
        if (itemTime && itemTime < watch.startedAt - 250) continue;
        const sameOrigin = flowOrigin(item.url) === watch.origin || flowOrigin(item.referrer) === watch.origin
          || (flowOrigin(item.url) === "google" && looksLikeVideoDownload(item));
        if (!sameOrigin) continue;
        if (item.mime && !/^video\//i.test(item.mime) && item.mime !== "application/octet-stream") continue;
        if (!item.url?.startsWith("blob:") && !looksLikeVideoDownload(item)) continue;

        if (watch.downloadId === undefined) {
          watch.downloadId = item.id;
          rememberDownloadRoute(watch, item.id);
        }
        if (item.state === "complete" || item.state === "interrupted") {
          await finishWatchedDownload(tabId, watch, item);
        }
        return { ok: true, matched: true, state: item.state };
      }
      return { ok: true, matched: false };
    }));
  }

  if (message?.type === "FLOW_NOTIFY_COMPLETION") {
    const title = message.title || "Flow Bulk Video Exporter";
    const text = message.message || "Export complete.";
    if (chrome.notifications?.create) {
      const iconUrl = chrome.runtime?.getURL ? chrome.runtime.getURL("icons/icon-128.png") : "icons/icon-128.png";
      chrome.notifications.create({
        type: "basic",
        iconUrl,
        title,
        message: text,
        priority: 2,
      }, (notifId) => {
        if (chrome.runtime?.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        sendResponse({ ok: true, notifId });
      });
      return true;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === "FLOW_DIRECT_DOWNLOAD") {
    let targetFilename = message.filename;
    if (message.subfolder) {
      targetFilename = `${message.subfolder}/${message.filename}`;
    }
    const options = {
      url: message.url,
      filename: targetFilename,
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
    let targetFilename = message.filename;
    if (message.subfolder) {
      targetFilename = `${message.subfolder}/${message.filename}`;
    }
    chrome.downloads.download({
      url: mediaDownloadUrl(message.mediaId),
      filename: targetFilename,
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
  rememberDownloadRoute(watch, item.id);
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
      const sameOrigin = flowOrigin(item.url) === watch.origin || flowOrigin(item.referrer) === watch.origin
        || (flowOrigin(item.url) === "google" && looksLikeVideoDownload(item));
      if (!sameOrigin || (item.mime && !/^video\//i.test(item.mime)
        && item.mime !== "application/octet-stream")) continue;
      if (!item.url?.startsWith("blob:") && !looksLikeVideoDownload(item)) continue;
      watch.downloadId = item.id;
      rememberDownloadRoute(watch, item.id);
      const [latest] = await chrome.downloads.search({ id: item.id });
      await finishWatchedDownload(tabId, watch, latest || item);
      break;
    }
  }).catch(() => undefined);
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!["complete", "interrupted"].includes(delta.state?.current)) return;
  void withWatches(async () => {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (item?.byExtensionId) return;

    for (const [tabId, watch] of activeWatches) {
      if (watch.downloadId !== undefined && watch.downloadId !== delta.id) continue;
      if (watch.downloadId === undefined) {
        if (!item) continue;
        const sameOrigin = flowOrigin(item.url) === watch.origin || flowOrigin(item.referrer) === watch.origin
          || (flowOrigin(item.url) === "google" && looksLikeVideoDownload(item));
        if (!sameOrigin) continue;
        if (item.mime && !/^video\//i.test(item.mime) && item.mime !== "application/octet-stream") continue;
        if (!item.url?.startsWith("blob:") && !looksLikeVideoDownload(item)) continue;
        watch.downloadId = item.id;
        rememberDownloadRoute(watch, item.id);
      }
      await finishWatchedDownload(tabId, watch, item || {
        id: delta.id, state: delta.state.current, error: delta.error?.current,
      });
      break;
    }
  }).catch(() => undefined);
});

if (chrome.downloads?.onDeterminingFilename?.addListener) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    void withWatches(async () => {
      try {
        let folder = "";
        let matchedWatch = false;
        const rememberedRoute = recentDownloadRoutes.get(item.id);
        if (rememberedRoute) {
          matchedWatch = true;
          folder = rememberedRoute.subfolder || "";
          recentDownloadRoutes.delete(item.id);
        } else {
          for (const [, watch] of activeWatches) {
            if (watch.downloadId === item.id || flowOrigin(item.url) === watch.origin || flowOrigin(item.referrer) === watch.origin
              || (flowOrigin(item.url) === "google" && looksLikeVideoDownload(item))) {
              matchedWatch = true;
              folder = watch.subfolder || "";
              break;
            }
          }
        }

        if (!matchedWatch || !folder) {
          suggest();
          return;
        }

        const cleanFolder = folder.replace(/\\/g, "/").split("/")
          .map((p) => p.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim())
          .filter(Boolean)
          .join("/") || "Flow_Export";
        const rawName = (item.filename || "").replace(/^.*[\\/]/, "");
        if (!rawName) {
          suggest();
          return;
        }
        suggest({ filename: `${cleanFolder}/${rawName}`, conflictAction: "uniquify" });
      } catch {
        suggest();
      }
    });
    return true;
  });
}
