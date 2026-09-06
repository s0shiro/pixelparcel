(function initializeFlowBulkExporter() {
  "use strict";

  if (globalThis.__flowBulkVideoExporterLoaded) return;
  globalThis.__flowBulkVideoExporterLoaded = true;

  const Core = globalThis.FlowBulkCore;
  const Modern = globalThis.FlowModernDom;
  const usesModernFlow = () => Boolean(Modern?.isModernPage(document, location.href));
  const SCROLL_WAIT_MS = 650;
  const MENU_WAIT_MS = 450;
  const DOWNLOAD_TIMEOUT = {
    "720p": 90_000,
    "1080p": 10 * 60_000,
  };
  const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  const state = {
    running: false,
    mode: "Idle",
    quality: null,
    lastQuality: null,
    stopRequested: false,
    found: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    message: "Ready",
    lastError: "",
  };

  let pendingDownload = null;
  let inventoryCache = null;

  function snapshotState() {
    return { ...state, failures: state.failures.map((failure) => ({ ...failure })) };
  }

  function recordFailure(video, index, error) {
    const message = error instanceof Error ? error.message : String(error);
    const mediaId = video?.mediaId || "";
    const title = Core.compactText(video?.title)
      || (mediaId ? `Video ${index} (${mediaId.slice(0, 8)})` : `Video ${index}`);
    state.failures.push({
      index,
      title,
      mediaId,
      quality: state.quality || state.lastQuality,
      error: message,
    });
    state.lastError = message;
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1
      && rect.height > 1
      && style.display !== "none"
      && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0;
  }

  function isOnScreen(element) {
    if (!isVisible(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth;
  }

  function visibleElements(selector, root = document) {
    return [...root.querySelectorAll(selector)].filter(isVisible);
  }

  function elementText(element) {
    return Core.compactText([
      element?.innerText,
      element?.getAttribute?.("aria-label"),
      element?.getAttribute?.("title"),
      element?.getAttribute?.("data-value"),
      element?.getAttribute?.("data-label"),
      element?.getAttribute?.("data-resolution"),
      ...[...(element?.querySelectorAll?.("i.google-symbols, .google-symbols") || [])]
        .map((icon) => icon.textContent),
    ].filter(Boolean).join(" "));
  }

  function dispatchPointerEvent(element, name) {
    const rect = element.getBoundingClientRect();
    const EventConstructor = name.startsWith("pointer") && typeof PointerEvent !== "undefined"
      ? PointerEvent
      : MouseEvent;
    element.dispatchEvent(new EventConstructor(name, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + Math.min(rect.width / 2, 20),
      clientY: rect.top + Math.min(rect.height / 2, 20),
      button: name === "contextmenu" ? 2 : 0,
      buttons: name === "contextmenu" ? 2 : 0,
    }));
  }

  async function waitFor(predicate, timeoutMs, intervalMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (state.stopRequested) return null;
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function videoSource(video) {
    return video.currentSrc
      || video.getAttribute("src")
      || [...video.querySelectorAll("source")].map((source) => source.src).find(Boolean)
      || "";
  }

  function mediaLabel(element, index, quality, preferredTitle = "") {
    let current = element;
    let label = "";
    for (let depth = 0; current && depth < 6 && !preferredTitle; depth += 1, current = current.parentElement) {
      label ||= current.getAttribute?.("aria-label") || current.getAttribute?.("title") || "";
    }
    const stem = Core.safeFilename(preferredTitle || label, `flow-video-${String(index).padStart(3, "0")}`);
    return `${stem}-${quality}.mp4`;
  }

  function projectVideos(visibleOnly = false) {
    return [...document.querySelectorAll("video")].filter((video) => {
      const rect = video.getBoundingClientRect();
      const largeEnough = rect.width >= 120 && rect.height >= 68;
      return largeEnough && (!visibleOnly || isOnScreen(video));
    });
  }

  function assetKey(video) {
    return Core.assetKeyFromVideo(video, location.href);
  }

  function extractMediaId(source) {
    if (!source || !String(source).includes("getMediaUrlRedirect")) return "";
    try {
      return new URL(source, location.href).searchParams.get("name") || "";
    } catch {
      return "";
    }
  }

  function mediaIdFromImage(image) {
    return extractMediaId(image.currentSrc || image.src || image.getAttribute("src"));
  }

  function mediaGridCards(visibleOnly = false) {
    if (usesModernFlow()) {
      return Modern.videoCards(document, location.href, visibleOnly ? isOnScreen : () => true);
    }
    const cards = new Map();
    for (const image of document.querySelectorAll('img[src*="getMediaUrlRedirect"]')) {
      if (visibleOnly && !isOnScreen(image)) continue;
      const mediaId = mediaIdFromImage(image);
      if (!mediaId || cards.has(mediaId)) continue;
      const tile = image.closest("button") || image;
      cards.set(mediaId, { mediaId, surface: image, tile, image });
    }
    return [...cards.values()];
  }

  function getProjectId() {
    const pathId = location.pathname.match(/\/project\/([0-9a-f-]{36})/i)?.[1];
    const queryId = new URLSearchParams(location.search).get("projectId") || "";
    return pathId || (UUID_PATTERN.test(queryId) ? queryId : "");
  }

  function inferCardType(card) {
    if (!card?.surface) return "unknown";
    const text = elementText(card.tile || card.surface);
    if (/\b(video|movie|videocam|play_arrow|play_circle)\b/i.test(text)
      || /\b\d{1,2}:\d{2}\b/.test(text)) return "video";
    return "unknown";
  }

  function normalizedTitle(value) {
    return Core.compactText(value)
      .toLowerCase()
      .replace(/[^a-z0-9\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  function cardMatchesTitle(card, title) {
    const target = normalizedTitle(title);
    if (target.length < 4) return false;
    const cardText = normalizedTitle(elementText(card.tile || card.surface));
    return cardText.includes(target);
  }

  async function ensureFullVideoGrid() {
    const candidates = visibleElements("[role='tab'], button, [role='button'], a, [role='link']");
    const label = (element) => Core.compactText(element.getAttribute("aria-label") || element.textContent)
      .replace(/^(?:videocam|video_library|dashboard)\s*/i, "");
    const videos = candidates.find((element) => /^videos(?:\s*\(?\d+\)?)?$/i.test(label(element)));
    const allMedia = candidates.find((element) => /^all media$/i.test(label(element)));
    const target = videos || allMedia;
    if (!target || target.getAttribute("aria-selected") === "true"
      || target.getAttribute("aria-current") === "page") return;
    target.click();
    await sleep(800);
  }

  async function classifyMediaItems(items) {
    const types = {};
    for (let offset = 0; offset < items.length && !state.stopRequested; offset += 40) {
      const batch = items.slice(offset, offset + 40);
      state.message = `Checking media types ${Math.min(offset + batch.length, items.length)}/${items.length}…`;
      const response = await chrome.runtime.sendMessage({
        type: "FLOW_CLASSIFY_MEDIA_IDS",
        mediaIds: batch.map((item) => item.mediaId),
      }).catch(() => ({ ok: false, types: {} }));
      Object.assign(types, response?.types || {});
    }
    return types;
  }

  async function fetchProjectInventory(force = false) {
    const projectId = getProjectId();
    if (!projectId) return null;
    if (!force && inventoryCache?.projectId === projectId) return inventoryCache.videos;

    state.message = "Reading the complete Flow project inventory…";
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_FETCH_PROJECT",
      projectId,
    });
    if (!response?.ok) throw new Error(response?.error || "The extension could not read the legacy Flow project inventory.");
    const payload = response.payload;
    const byId = new Map();

    (function walk(node) {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;

      const metadata = node.metadata;
      if (metadata && typeof metadata === "object"
        && typeof metadata.primaryMediaId === "string"
        && UUID_PATTERN.test(metadata.primaryMediaId)) {
        byId.set(metadata.primaryMediaId, {
          mediaId: metadata.primaryMediaId,
          title: typeof metadata.displayName === "string" ? metadata.displayName.trim() : "",
        });
      } else if (typeof node.name === "string"
        && UUID_PATTERN.test(node.name)
        && typeof node.displayName === "string") {
        byId.set(node.name, { mediaId: node.name, title: node.displayName.trim() });
      }
      Object.values(node).forEach(walk);
    })(payload);

    const items = [...byId.values()];
    if (!items.length) throw new Error("Flow returned an empty project inventory.");
    const types = await classifyMediaItems(items);
    const knownTypeCount = Object.values(types).filter((type) => type === "video" || type === "image").length;
    if (!knownTypeCount) throw new Error("Flow media types could not be read from the project inventory.");
    const cardsById = new Map(mediaGridCards(false).map((card) => [card.mediaId, card]));
    const videos = items.filter((item) => {
      const cardType = inferCardType(cardsById.get(item.mediaId));
      return types[item.mediaId] === "video" || (types[item.mediaId] === "unknown" && cardType === "video");
    });

    inventoryCache = { projectId, videos, loadedAt: Date.now() };
    return videos;
  }

  function findScrollableAncestor(video) {
    const viewport = video?.closest("cdk-virtual-scroll-viewport");
    if (viewport) return viewport;
    let current = video?.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY)
        && current.scrollHeight > current.clientHeight + 120
        && current.clientHeight > 180) {
        return current;
      }
      current = current.parentElement;
    }

    const candidates = [...document.querySelectorAll("main *, [role='main'] *")]
      .filter((element) => {
        if (!isVisible(element) || element.clientHeight < 220) return false;
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY)
          && element.scrollHeight > element.clientHeight + 180;
      })
      .sort((left, right) => right.scrollHeight - left.scrollHeight);

    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  function getScrollTop(container) {
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      return window.scrollY;
    }
    return container.scrollTop;
  }

  function setScrollTop(container, value) {
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      window.scrollTo({ top: value, behavior: "instant" });
    } else {
      container.scrollTo({ top: value, behavior: "instant" });
    }
  }

  function scrollMetrics(container) {
    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      return {
        top: window.scrollY,
        viewport: window.innerHeight,
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      };
    }
    return { top: container.scrollTop, viewport: container.clientHeight, height: container.scrollHeight };
  }

  async function openAssetMenu(video) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    video.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await sleep(120);

    dispatchPointerEvent(video, "contextmenu");
    let menu = await waitFor(
      () => visibleElements("[role='menu']")[0]
        || visibleElements("[role='menuitem']").find((item) => /\bdownload\b/i.test(elementText(item))),
      1_200,
    );
    if (menu) return true;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    dispatchPointerEvent(video, "mouseenter");
    dispatchPointerEvent(video, "mouseover");
    await sleep(200);

    let current = video;
    const tileBoundary = video.closest("flow-grid-tile-container");
    let moreButton = null;
    for (let depth = 0; current && depth < 7 && !moreButton; depth += 1, current = current.parentElement) {
      const buttons = [...current.querySelectorAll("button")].filter(isVisible);
      moreButton = buttons.find((button) => /(?:more_vert|\bmore\b|\boptions?\b|\bmenu\b)/i.test(elementText(button)));
      if (current === tileBoundary) break;
    }

    if (!moreButton) return false;
    moreButton.click();
    menu = await waitFor(
      () => visibleElements("[role='menu']")[0]
        || visibleElements("[role='menuitem']").find((item) => /\bdownload\b/i.test(elementText(item))),
      1_500,
    );
    return Boolean(menu);
  }

  function resolutionCandidates() {
    const selector = [
      "[role='menuitem']",
      "[role='menuitemradio']",
      "[role='option']",
      "[role='radio']",
      "button",
      "[data-value]",
      "[data-resolution]",
    ].join(", ");
    const seen = new Set();
    const roots = visibleElements("[role='menu'], [role='listbox'], [role='dialog']");
    const candidates = roots.length
      ? roots.flatMap((root) => visibleElements(selector, root))
      : [];
    return candidates
      .filter((element) => {
        if (seen.has(element)) return false;
        seen.add(element);
        return /\b(?:\d{3,4}p|[48]k|[124]x|original)\b/i.test(elementText(element));
      })
      .map((element) => ({
        element,
        text: elementText(element),
        disabled: Core.isDisabledElement(element),
      }));
  }

  async function exposeDownloadChoices(quality, originalHeight) {
    const items = visibleElements("[role='menuitem'], [role='option']");
    const download = items.find((item) => {
      const text = elementText(item);
      return /^download(?:\b|$)/i.test(text) || /(?:^|\s)download(?:\s|$)/i.test(text);
    });
    if (!download) return false;

    const choicesVisible = () => Boolean(
      Core.selectResolutionCandidate(resolutionCandidates(), quality, originalHeight),
    );

    if (download.getAttribute("aria-haspopup")) {
      const flowItem = download.closest("flow-menu-item");
      if (flowItem) dispatchPointerEvent(flowItem, "mouseenter");
      dispatchPointerEvent(download, "pointerenter");
      dispatchPointerEvent(download, "pointerover");
      dispatchPointerEvent(download, "pointermove");
      dispatchPointerEvent(download, "mouseenter");
      dispatchPointerEvent(download, "mouseover");
      download.focus();
      if (await waitFor(choicesVisible, 1_200, 100)) return true;
    }

    download.click();
    if (await waitFor(choicesVisible, 1_200, 100)) return true;

    download.focus();
    download.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      code: "ArrowRight",
      bubbles: true,
      cancelable: true,
    }));
    await sleep(MENU_WAIT_MS);
    return choicesVisible();
  }

  function findResolutionChoice(quality, originalHeight) {
    return Core.selectResolutionCandidate(resolutionCandidates(), quality, originalHeight);
  }

  function visibleResolutionSummary() {
    const labels = resolutionCandidates().map((candidate) => candidate.text);
    return [...new Set(labels)].slice(0, 8).join(" | ");
  }

  async function confirmFlowDialog() {
    await sleep(350);
    const dialogs = visibleElements("[role='dialog']");
    for (const dialog of dialogs) {
      const buttons = visibleElements("button, [role='button']", dialog)
        .filter((button) => !Core.isDisabledElement(button));
      const confirm = buttons.find((button) => /\b(upscale|download|confirm|continue|start)\b/i.test(elementText(button)));
      if (confirm) {
        confirm.click();
        await sleep(250);
        return true;
      }
    }
    return false;
  }

  function beginDownloadWatch(token, timeoutMs) {
    if (pendingDownload) pendingDownload.resolve({ kind: "cancelled" });

    let timer;
    const promise = new Promise((resolve) => {
      pendingDownload = { token, resolve };
      timer = setTimeout(() => {
        if (pendingDownload?.token === token) pendingDownload = null;
        resolve({ kind: "timeout" });
      }, timeoutMs);
    }).finally(() => clearTimeout(timer));

    const ready = chrome.runtime.sendMessage({ type: "FLOW_WATCH_DOWNLOAD", token })
      .catch(() => ({ ok: false }));
    return { promise, ready };
  }

  function cancelDownloadWatch(token) {
    if (pendingDownload?.token === token) {
      pendingDownload.resolve({ kind: "cancelled" });
      pendingDownload = null;
    }
    chrome.runtime.sendMessage({ type: "FLOW_CANCEL_DOWNLOAD_WATCH", token }).catch(() => undefined);
  }

  async function waitForNewMedia(baselineMediaIds, baselineVideoKeys, timeoutMs) {
    return waitFor(() => {
      for (const card of mediaGridCards(false)) {
        if (!baselineMediaIds.has(card.mediaId)) return { kind: "media-id", ...card };
      }
      for (const video of projectVideos(false)) {
        const key = assetKey(video);
        if (key && !baselineVideoKeys.has(key) && videoSource(video)) {
          return { kind: "video", video };
        }
      }
      return null;
    }, timeoutMs, 1_000);
  }

  async function directDownloadVideo(video, filename) {
    const url = videoSource(video);
    if (!url) throw new Error("Flow produced the upscale, but its video URL was not available.");

    if (!url.startsWith("blob:")) {
      const response = await chrome.runtime.sendMessage({
        type: "FLOW_DIRECT_DOWNLOAD",
        url,
        filename,
      });
      if (response?.ok) return true;
    }

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  async function directDownloadMediaId(mediaId, filename) {
    const response = await chrome.runtime.sendMessage({
      type: "FLOW_DOWNLOAD_MEDIA",
      mediaId,
      filename,
    });
    if (!response?.ok) throw new Error(response?.error || "Chrome could not start the Flow download.");
    await waitForDownloadCompletion(response.downloadId);
    return response.downloadId;
  }

  async function waitForDownloadCompletion(downloadId) {
    const deadline = Date.now() + DOWNLOAD_TIMEOUT["720p"];
    while (!state.stopRequested && Date.now() < deadline) {
      const result = await chrome.runtime.sendMessage({ type: "FLOW_DOWNLOAD_STATUS", downloadId });
      if (!result?.ok) throw new Error(result?.error || "Chrome could not check the download.");
      if (result.state === "complete") return;
      if (result.state === "interrupted") throw new Error(`Download interrupted: ${result.error || "unknown error"}. Retry this video.`);
      await sleep(500);
    }
    throw new Error(state.stopRequested ? "Export stopped." : "Download has not completed. Check Chrome Downloads before retrying.");
  }

  function visibleFailureMessage() {
    const text = visibleElements("[role='alert'], [role='status'], [role='dialog']")
      .map(elementText)
      .join(" ");
    const match = text.match(
      /(?:upscal|download|export).{0,140}(?:failed|couldn.?t|unable|unavailable|not supported|try again|upgrade|subscription|credits?)/i,
    ) || text.match(
      /(?:failed|couldn.?t|unable|unavailable|not supported).{0,140}(?:upscal|download|export)/i,
    );
    return Core.compactText(match?.[0] || "").slice(0, 220);
  }

  async function waitForUpscaleFailure(timeoutMs) {
    return waitFor(() => {
      const message = visibleFailureMessage();
      return message ? { kind: "flow-failure", message } : null;
    }, timeoutMs, 500);
  }

  async function exportMediaCard(card, quality, index, title = "") {
    const surface = card.surface || card.video;
    const video = surface instanceof HTMLVideoElement
      ? surface
      : surface?.querySelector?.("video");
    if (!surface?.isConnected) throw new Error("The video card was unloaded before it could be exported.");

    if (!card.nativeMenu && video && video.readyState < 1) {
      video.preload = "metadata";
      video.load();
      await waitFor(() => video.readyState >= 1, 2_500);
    }

    const baselineMediaIds = new Set(mediaGridCards(false).map((item) => item.mediaId));
    const baselineVideoKeys = new Set(projectVideos(false).map(assetKey).filter(Boolean));
    const menuOpened = await openAssetMenu(surface);
    if (!menuOpened) throw new Error("Could not open this video’s Flow menu.");

    await exposeDownloadChoices(quality, video?.videoHeight || 0);
    const choice = await waitFor(() => findResolutionChoice(quality, video?.videoHeight || 0), 3_500);
    if (!choice) {
      const summary = visibleResolutionSummary();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      throw new Error(
        `${quality} is not available for this video or account.${summary ? ` Flow showed: ${summary}` : ""}`,
      );
    }

    if (choice.disabled) throw new Error(`${quality} is disabled for this video or account.`);

    const token = `${quality}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const downloadWatch = beginDownloadWatch(token, DOWNLOAD_TIMEOUT[quality]);
    const ready = await downloadWatch.ready;
    if (!ready?.ok) {
      cancelDownloadWatch(token);
      throw new Error(ready?.error || "Chrome could not monitor the download. Reload the extension and Flow tab.");
    }
    const existingFailure = visibleFailureMessage();
    choice.element.click();
    await confirmFlowDialog();

    if (card.nativeMenu) {
      // New Flow downloads the result itself. A newly mounted grid tile is not
      // evidence that an upscale completed, and may be an unrelated generation.
      const stopPolling = { done: false };
      try {
        const failure = (async () => {
          const deadline = Date.now() + DOWNLOAD_TIMEOUT[quality];
          while (!stopPolling.done && !state.stopRequested && Date.now() < deadline) {
            const message = visibleFailureMessage();
            if (message && message !== existingFailure) return { kind: "flow-failure", message };
            await sleep(500);
          }
          return { kind: state.stopRequested ? "cancelled" : "timeout" };
        })();
        const result = await Promise.race([downloadWatch.promise, failure]);
        if (result.kind === "download") return;
        throw new Error(result.message || (state.stopRequested
          ? "Export stopped."
          : `Flow did not complete the ${quality} download. Check Flow's message and Chrome Downloads, then retry this video.`));
      } finally {
        stopPolling.done = true;
        cancelDownloadWatch(token);
      }
    }

    if (quality === "720p") {
      const result = await downloadWatch.promise;
      if (result.kind === "download") return;
      const failure = visibleFailureMessage();
      cancelDownloadWatch(token);
      throw new Error(result.message || failure || "Flow did not complete the 720p download within 90 seconds.");
    }

    const newMediaPromise = waitForNewMedia(
      baselineMediaIds,
      baselineVideoKeys,
      DOWNLOAD_TIMEOUT[quality],
    );
    const result = await Promise.race([
      downloadWatch.promise,
      newMediaPromise.then((newMedia) => ({ kind: "new-media", newMedia })),
      waitForUpscaleFailure(DOWNLOAD_TIMEOUT[quality]),
    ]);

    if (result.kind === "download") return;
    if (result.kind === "flow-failure" || result.kind === "download-failure") {
      cancelDownloadWatch(token);
      throw new Error(result.message);
    }
    if (result.kind === "new-media" && result.newMedia?.kind === "media-id") {
      cancelDownloadWatch(token);
      await directDownloadMediaId(
        result.newMedia.mediaId,
        mediaLabel(surface, index, quality, title),
      );
      return;
    }
    if (result.kind === "new-media" && result.newMedia?.kind === "video") {
      cancelDownloadWatch(token);
      await directDownloadVideo(
        result.newMedia.video,
        mediaLabel(surface, index, quality, title),
      );
      return;
    }

    const failure = visibleFailureMessage();
    cancelDownloadWatch(token);
    throw new Error(failure || "The 1080p upscale did not finish within 10 minutes.");
  }

  function visibleDiscoveryCards() {
    const gridCards = mediaGridCards(true);
    if (gridCards.length || usesModernFlow()) return gridCards;
    return projectVideos(true).map((video) => ({
      mediaId: assetKey(video),
      surface: video,
      video,
    }));
  }

  function allScrollableCandidates(exclude = null) {
    return [...document.querySelectorAll("*")]
      .filter((element) => {
        if (element === exclude || !isVisible(element) || element.clientHeight < 180) return false;
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY)
          && element.scrollHeight > element.clientHeight + 40;
      })
      .sort((left, right) => {
        const leftOverflow = left.scrollHeight - left.clientHeight;
        const rightOverflow = right.scrollHeight - right.clientHeight;
        return rightOverflow - leftOverflow;
      });
  }

  async function walkMediaGrid(targetById, onCard) {
    await ensureFullVideoGrid();
    let seedCards = visibleDiscoveryCards();
    if (!seedCards.length) {
      state.message = "Waiting for Flow media cards…";
      seedCards = await waitFor(() => {
        const cards = visibleDiscoveryCards();
        return cards.length ? cards : null;
      }, 5_000) || [];
    }
    if (!seedCards.length) throw new Error("No media cards were found in the current Flow project view.");

    let scrollContainer = findScrollableAncestor(seedCards[0].surface);
    const initialContainer = scrollContainer;
    const originalTop = getScrollTop(initialContainer);
    const originalWindowTop = window.scrollY;
    const rendered = new Map();
    const matched = new Set();
    const expectedCount = targetById?.size || null;
    const titleTargets = targetById
      ? [...targetById.values()].filter((target) => normalizedTitle(target.title).length >= 4)
      : [];
    let hardDeadline = Date.now() + 5 * 60_000;
    let stableRounds = 0;
    let triedFallback = false;
    let pass = 0;

    try {
      setScrollTop(scrollContainer, 0);
      scrollContainer.dispatchEvent?.(new Event("scroll", { bubbles: true }));
      window.scrollTo({ top: 0, behavior: "instant" });
      await sleep(SCROLL_WAIT_MS);

      while (!state.stopRequested && Date.now() < hardDeadline && pass < 2000) {
        pass += 1;
        const visibleCards = visibleDiscoveryCards();
        let newInPass = 0;

        for (const card of visibleCards) {
          if (state.stopRequested) break;
          if (!card.mediaId || rendered.has(card.mediaId)) continue;
          rendered.set(card.mediaId, card);
          newInPass += 1;

          let target = targetById?.get(card.mediaId);
          if (!target && targetById && !card.nativeMenu) {
            target = titleTargets.find((candidate) => {
              return !matched.has(candidate.mediaId) && cardMatchesTitle(card, candidate.title);
            });
          }
          if (targetById && !target) continue;
          matched.add(target?.mediaId || card.mediaId);
          const exportStarted = Date.now();
          await onCard(card, matched.size, target || null);
          // The grid-discovery budget must not include 1080p render time.
          hardDeadline += Date.now() - exportStarted;
        }

        if (expectedCount && matched.size >= expectedCount) break;

        if (newInPass === 0) stableRounds += 1;
        else stableRounds = 0;

        if (!usesModernFlow() && stableRounds === 3 && !triedFallback) {
          triedFallback = true;
          const fallback = allScrollableCandidates(scrollContainer)[0];
          if (fallback) {
            scrollContainer = fallback;
            setScrollTop(scrollContainer, 0);
            stableRounds = 0;
          }
        }

        const giveUpRounds = expectedCount && matched.size < expectedCount ? 45 : 7;
        const metrics = scrollMetrics(scrollContainer);
        const atBottom = metrics.top + metrics.viewport >= metrics.height - 12;
        if (atBottom && stableRounds >= giveUpRounds) break;
        if (!atBottom) {
          const nextTop = Math.min(
            Math.max(0, metrics.height - metrics.viewport),
            metrics.top + Math.max(300, Math.floor(metrics.viewport * 0.82)),
          );
          setScrollTop(scrollContainer, nextTop);
        }
        scrollContainer.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        if (!usesModernFlow()) window.scrollTo({
          top: Math.min(
            window.scrollY + Math.max(300, Math.floor(window.innerHeight * 0.82)),
            Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          ),
          behavior: "instant",
        });
        await sleep(atBottom ? 1_000 : SCROLL_WAIT_MS);
      }
    } finally {
      setScrollTop(initialContainer, originalTop);
      window.scrollTo({ top: originalWindowTop, behavior: "instant" });
    }

    if (!state.stopRequested && (Date.now() >= hardDeadline || pass >= 2000)) {
      throw new Error(`Grid scan reached its time limit after ${matched.size} videos. The scan is incomplete; try a smaller collection.`);
    }
    return { rendered, matched };
  }

  async function fallbackVideoInventory() {
    const cards = new Map();
    await walkMediaGrid(null, async (card) => {
      cards.set(card.mediaId, card);
      state.message = `Loaded ${cards.size} media cards…`;
    });

    const items = [...cards.values()]
      .filter((card) => UUID_PATTERN.test(card.mediaId))
      .map((card) => ({ mediaId: card.mediaId, title: "", card }));
    const types = await classifyMediaItems(items);
    return items.filter((item) => {
      return types[item.mediaId] === "video"
        || (types[item.mediaId] === "unknown" && inferCardType(item.card) === "video");
    });
  }

  async function resolveVideoInventory(force = false) {
    if (usesModernFlow()) {
      const videos = [];
      state.message = "Scanning Flow's current video grid…";
      await walkMediaGrid(null, async (card) => {
        videos.push({ mediaId: card.mediaId, title: card.title, nativeMenu: true });
        state.found = videos.length;
        state.message = `Scanning Flow's video grid — ${videos.length} videos found…`;
      });
      return videos;
    }
    try {
      const inventory = await fetchProjectInventory(force);
      if (Array.isArray(inventory)) return inventory;
      throw new Error("This page URL does not expose a Flow project ID.");
    } catch (error) {
      state.message = "Project inventory unavailable; scanning the full media grid…";
      try {
        const videos = await fallbackVideoInventory();
        if (!videos.length && !state.stopRequested) throw new Error("No videos could be verified in the visible grid.");
        state.lastError = "";
        return videos;
      } catch (gridError) {
        throw new Error(`${error.message} Grid scan: ${gridError.message}`);
      }
    }
  }

  function resetState(mode, quality = null) {
    Object.assign(state, {
      running: true,
      mode,
      quality,
      lastQuality: quality || state.lastQuality,
      stopRequested: false,
      found: 0,
      processed: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      message: mode === "Scan" ? "Scanning project…" : `Preparing ${quality} export…`,
      lastError: "",
    });
  }

  async function scanProject() {
    if (state.running) return;
    resetState("Scan");
    try {
      const videos = await resolveVideoInventory(true);
      state.found = videos.length;
      state.processed = videos.length;
      state.message = state.stopRequested
        ? `Scan stopped after ${state.found} videos`
        : `Found ${state.found} videos`;
    } catch (error) {
      state.failed += 1;
      state.lastError = error.message;
      state.message = error.message;
    } finally {
      state.running = false;
      state.mode = "Idle";
    }
  }

  async function runBatch(quality, requestedFailures = null) {
    if (state.running) return;
    resetState(quality === "720p" ? "720p export" : "1080p upscale", quality);

    try {
      const completeInventory = await resolveVideoInventory(Boolean(requestedFailures?.length));
      let videos = completeInventory;
      if (requestedFailures?.length) {
        const selected = [];
        const usedIds = new Set();
        for (const failure of requestedFailures) {
          let match = completeInventory.find((video) => video.mediaId === failure.mediaId);
          if (!match && normalizedTitle(failure.title).length >= 4) {
            match = completeInventory.find((video) => {
              return !usedIds.has(video.mediaId)
                && normalizedTitle(video.title) === normalizedTitle(failure.title);
            });
          }
          match ||= { mediaId: failure.mediaId, title: failure.title };
          if (!usedIds.has(match.mediaId)) {
            selected.push(match);
            usedIds.add(match.mediaId);
          }
        }
        videos = selected;
      }
      state.found = videos.length;

      if (quality === "720p" && !usesModernFlow()) {
        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {
          const video = videos[index];
          state.message = `720p: downloading video ${index + 1}/${videos.length}…`;
          try {
            await directDownloadMediaId(
              video.mediaId,
              mediaLabel(null, index + 1, quality, video.title),
            );
            state.success += 1;
          } catch (error) {
            state.failed += 1;
            recordFailure(video, index + 1, error);
          } finally {
            state.processed += 1;
            await sleep(120);
          }
        }
      } else {
        if (!videos.length) {
          state.message = state.stopRequested ? "Scan stopped." : "No completed videos were found in this Flow view.";
          return;
        }
        const targetById = new Map(videos.map((video) => [video.mediaId, video]));
        const walkResult = await walkMediaGrid(targetById, async (card, matchIndex, video) => {
          state.message = `${quality}: processing video ${state.processed + 1}/${videos.length}…`;
          try {
            await exportMediaCard(card, quality, matchIndex, video?.title || "");
            state.success += 1;
          } catch (error) {
            state.failed += 1;
            recordFailure(video, state.processed + 1, error);
            state.message = `${quality}: ${error.message}`;
          } finally {
            state.processed += 1;
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await sleep(300);
          }
        });

        const missing = state.stopRequested ? 0 : Math.max(0, videos.length - walkResult.matched.size);
        if (missing) {
          state.failed += missing;
          state.processed += missing;
          state.lastError = `${missing} video card${missing === 1 ? " was" : "s were"} not exposed by Flow's media grid.`;
          for (const video of videos) {
            if (!walkResult.matched.has(video.mediaId)) {
              recordFailure(video, videos.indexOf(video) + 1, new Error("Video card was not exposed by Flow's media grid."));
            }
          }
        }
      }

      if (state.stopRequested) {
        state.message = `Stopped — ${state.success} downloaded, ${state.failed} failed`;
      } else {
        state.message = `Finished — ${state.success} downloaded, ${state.failed} failed`;
      }
    } catch (error) {
      state.failed += 1;
      state.lastError = error.message;
      state.message = error.message;
    } finally {
      if (pendingDownload) cancelDownloadWatch(pendingDownload.token);
      state.running = false;
      state.mode = "Idle";
      state.quality = null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "FLOW_GET_STATUS") {
      sendResponse(snapshotState());
      return false;
    }

    if (message?.type === "FLOW_SCAN_PROJECT") {
      if (!state.running) void scanProject();
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }

    if (message?.type === "FLOW_START_BATCH") {
      if (!["720p", "1080p"].includes(message.quality)) {
        sendResponse({ ok: false, error: "Unsupported export quality." });
        return false;
      }
      if (!state.running) void runBatch(message.quality);
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }

    if (message?.type === "FLOW_RETRY_FAILURES") {
      if (state.running) {
        sendResponse({ ok: false, error: "A Flow export is already running." });
        return false;
      }
      const retryable = state.failures.filter((failure) => failure.mediaId);
      const quality = retryable[0]?.quality || state.lastQuality;
      if (!retryable.length || !["720p", "1080p"].includes(quality)) {
        sendResponse({ ok: false, error: "There are no retryable failed videos." });
        return false;
      }
      const uniqueFailures = retryable.filter((failure, index, failures) => {
        return failures.findIndex((candidate) => candidate.mediaId === failure.mediaId) === index;
      });
      void runBatch(quality, uniqueFailures);
      sendResponse({ ok: true, retryCount: uniqueFailures.length });
      return false;
    }

    if (message?.type === "FLOW_STOP_BATCH") {
      state.stopRequested = true;
      state.message = "Stopping after the current video…";
      if (pendingDownload) pendingDownload.resolve({ kind: "cancelled" });
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }

    if (message?.type === "FLOW_DOWNLOAD_DETECTED" && pendingDownload?.token === message.token) {
      const pending = pendingDownload;
      pendingDownload = null;
      pending.resolve({
        kind: "download",
        downloadId: message.downloadId,
        filename: message.filename,
      });
      return false;
    }

    if (message?.type === "FLOW_DOWNLOAD_FAILED" && pendingDownload?.token === message.token) {
      const pending = pendingDownload;
      pendingDownload = null;
      pending.resolve({ kind: "download-failure", message: message.error || "Chrome could not finish downloading this video." });
      return false;
    }

    return false;
  });

  window.addEventListener("keydown", (event) => {
    if (event.isTrusted && event.key === "Escape" && state.running) {
      state.stopRequested = true;
      state.message = "Stopping after the current video…";
    }
  }, true);
})();
