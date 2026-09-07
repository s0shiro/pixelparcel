(function initializeFlowBulkExporter() {
  "use strict";

  if (globalThis.__flowBulkVideoExporterLoaded) return;
  globalThis.__flowBulkVideoExporterLoaded = true;

  const Core = globalThis.FlowBulkCore;
  const Modern = globalThis.FlowModernDom;
  const usesModernFlow = () => Boolean(Modern?.isModernPage(document, location.href));
  const SCROLL_WAIT_MS = 350;
  const MENU_WAIT_MS = 450;
  const DOWNLOAD_TIMEOUT = {
    "720p": 90_000,
    "1080p": 5 * 60_000,
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
    startTime: null,
    elapsed: "00:00",
    eta: "--:--",
    speed: "--",
    projectTitle: "",
    failures: [],
    message: "Ready",
    lastError: "",
  };

  let pendingDownload = null;
  let inventoryCache = null;
  let modernInventoryCache = null;
  let activeSubfolder = "";
  const selectedMediaIds = new Set();
  let lastSelectedMediaId = null;
  const selectionButtons = new Map();
  const selectionButtonCards = new WeakMap();
  const tileMediaIds = new WeakMap();
  let tileSelectionAnchors = new WeakMap();
  let selectionLayer = null;
  let selectionListenersAttached = false;
  let selectionUpdateScheduled = false;
  const activityLogs = [];

  function log(message) {
    const time = new Date().toLocaleTimeString();
    const entry = `[${time}] ${message}`;
    activityLogs.push(entry);
    if (activityLogs.length > 300) activityLogs.shift();
    console.log(`[FlowExporter] ${message}`);
  }

  function sendRuntimeMessage(message) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message));
    } catch (error) {
      // Chrome throws synchronously when this tab still has an older content
      // script after the extension has been reloaded. Returning a rejected
      // Promise lets every existing catch/await path handle it normally.
      return Promise.reject(error);
    }
  }

  function getProjectTitle() {
    try {
      const fromInput = document.querySelector("flow-project-title input, [data-project-title] input, input[aria-label*='project' i], input[aria-label*='Project title' i]")?.value;
      if (fromInput?.trim()) return fromInput.trim();
      const fromEl = document.querySelector("flow-project-title flow-editable-text, [data-project-title], [aria-label*='Project title' i], [aria-label*='Project name' i]")?.textContent;
      if (fromEl?.trim()) return fromEl.trim();
      const h1 = document.querySelector("h1")?.textContent;
      if (h1?.trim()) return h1.trim();
      const docTitle = (document.title || "")
        .replace(/\s*[-|•]\s*Google\s*Flow.*$/i, "")
        .replace(/\s*[-|•]\s*Flow.*$/i, "")
        .trim();
      return docTitle || "Flow_Project";
    } catch {
      return "Flow_Project";
    }
  }

  function playCompletionChime(isSuccess = true) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      if (isSuccess) {
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880, now + 0.12);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      } else {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(311.13, now + 0.15);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      }
    } catch {}
  }

  async function notifyCompletion(title, message) {
    try {
      await sendRuntimeMessage({
        type: "FLOW_NOTIFY_COMPLETION",
        title,
        message,
      });
    } catch {}
  }

  function ensureGridSelectionStyles() {
    if (typeof document === "undefined" || !document.head || document.getElementById("flow-bulk-exporter-grid-styles")) return;
    const style = document.createElement("style");
    style.id = "flow-bulk-exporter-grid-styles";
    style.textContent = `
      .flow-exporter-select-btn {
        position: absolute;
        top: 8px;
        left: 8px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.45);
        background: rgba(16, 17, 20, 0.8);
        backdrop-filter: blur(4px);
        cursor: pointer;
        z-index: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        box-sizing: border-box;
        padding: 0;
        outline: none;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        pointer-events: auto;
      }
      .flow-exporter-select-btn:hover {
        transform: scale(1.12);
        border-color: #a894ff;
        background: rgba(24, 26, 32, 0.95);
        box-shadow: 0 0 8px rgba(139, 108, 255, 0.5);
      }
      .flow-exporter-select-btn.selected {
        background: #7f62f4;
        border-color: #ffffff;
        box-shadow: 0 0 10px rgba(127, 98, 244, 0.8);
      }
      .flow-exporter-select-btn svg {
        width: 13px;
        height: 13px;
        fill: none;
        stroke: #ffffff;
        stroke-width: 2.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease;
      }
      .flow-exporter-select-btn.selected svg {
        opacity: 1;
      }
      .flow-exporter-selection-layer {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
        overflow: hidden;
      }
      .flow-exporter-dock {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(16, 18, 24, 0.94);
        backdrop-filter: blur(14px);
        border: 1px solid #353b47;
        border-radius: 30px;
        padding: 6px 14px 6px 18px;
        display: flex;
        align-items: center;
        gap: 10px;
        z-index: 100000;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6), 0 0 20px rgba(139, 108, 255, 0.25);
        font-family: "DM Sans", system-ui, -apple-system, sans-serif;
        color: #f5f7fb;
        animation: flowDockSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      @keyframes flowDockSlideUp {
        from { opacity: 0; transform: translate(-50%, 15px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }
      .flow-exporter-dock-count {
        font-size: 13px;
        font-weight: 700;
        color: #a894ff;
        white-space: nowrap;
      }
      .flow-exporter-dock-btn {
        border: 0;
        border-radius: 20px;
        padding: 6px 14px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
        transition: all 120ms ease;
        white-space: nowrap;
        outline: none;
      }
      .flow-exporter-dock-btn.primary {
        background: #f5f7fb;
        color: #111318;
      }
      .flow-exporter-dock-btn.primary:hover {
        background: #ffffff;
        transform: translateY(-1px);
      }
      .flow-exporter-dock-btn.upscale {
        background: linear-gradient(90deg, #8b6cff, #63a8ff);
        color: #ffffff;
      }
      .flow-exporter-dock-btn.upscale:hover {
        filter: brightness(1.1);
        transform: translateY(-1px);
      }
      .flow-exporter-dock-btn.clear {
        background: transparent;
        color: #8c93a3;
        padding: 6px 10px;
      }
      .flow-exporter-dock-btn.clear:hover {
        color: #ffb5bd;
      }
    `;
    document.head.append(style);
  }

  function updateFloatingDock() {
    if (typeof document === "undefined" || !document.body) return;
    let dock = document.getElementById("flow-exporter-dock");
    if (selectedMediaIds.size === 0) {
      if (dock) dock.remove();
      return;
    }

    if (!dock) {
      dock = document.createElement("div");
      dock.id = "flow-exporter-dock";
      dock.className = "flow-exporter-dock";
      document.body.append(dock);
    }

    const count = selectedMediaIds.size;
    dock.replaceChildren();

    const countSpan = document.createElement("span");
    countSpan.className = "flow-exporter-dock-count";
    countSpan.textContent = `${count} selected`;

    const btn720 = document.createElement("button");
    btn720.className = "flow-exporter-dock-btn primary";
    btn720.type = "button";
    btn720.textContent = "Download 720p";
    btn720.onclick = () => {
      void runBatch("720p", null, { selectedMediaIds: [...selectedMediaIds] });
    };

    const btn1080 = document.createElement("button");
    btn1080.className = "flow-exporter-dock-btn upscale";
    btn1080.type = "button";
    btn1080.textContent = "Upscale 1080p";
    btn1080.onclick = () => {
      void runBatch("1080p", null, { selectedMediaIds: [...selectedMediaIds] });
    };

    const btnClear = document.createElement("button");
    btnClear.className = "flow-exporter-dock-btn clear";
    btnClear.type = "button";
    btnClear.textContent = "Clear";
    btnClear.onclick = () => {
      selectedMediaIds.clear();
      lastSelectedMediaId = null;
      tileSelectionAnchors = new WeakMap();
      updateAllDecoratedButtons();
      updateFloatingDock();
    };

    dock.append(countSpan, btn720, btn1080, btnClear);
  }

  function updateAllDecoratedButtons() {
    if (typeof document === "undefined") return;
    for (const btn of document.querySelectorAll(".flow-exporter-select-btn")) {
      const mediaId = btn.dataset.mediaId;
      const isSelected = selectedMediaIds.has(mediaId);
      btn.classList.toggle("selected", isSelected);
      btn.setAttribute("aria-pressed", String(isSelected));
    }
  }

  function ensureSelectionLayer() {
    if (selectionLayer?.isConnected) return selectionLayer;
    selectionLayer = document.createElement("div");
    selectionLayer.id = "flow-exporter-selection-layer";
    selectionLayer.className = "flow-exporter-selection-layer";
    selectionLayer.setAttribute("aria-label", "Flow Bulk Video Exporter selection controls");
    document.body.append(selectionLayer);
    selectionButtons.clear();
    return selectionLayer;
  }

  function stopSelectionEvent(event) {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function createSelectionButton(mediaId) {
    const btn = document.createElement("button");
    btn.className = "flow-exporter-select-btn";
    btn.type = "button";
    btn.dataset.mediaId = mediaId;
    btn.setAttribute("aria-label", "Select video for export");
    btn.setAttribute("title", "Select video for export (Shift+Click for range)");
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    let suppressClickUntil = 0;
    for (const eventName of [
      "pointerdown",
      "pointercancel",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "dblclick",
      "contextmenu",
    ]) {
      btn.addEventListener(eventName, stopSelectionEvent, { capture: true, passive: false });
    }
    btn.addEventListener("pointerup", (event) => {
      const currentMediaId = btn.dataset.mediaId;
      const isPrimaryPointer = event.button === undefined || event.button === 0;
      const isShift = event.shiftKey;
      stopSelectionEvent(event);
      if (!isPrimaryPointer) return;
      suppressClickUntil = Date.now() + 500;
      toggleCardSelection(selectionButtonCards.get(btn) || { mediaId: currentMediaId }, isShift);
    }, { capture: true });
    btn.addEventListener("click", (event) => {
      const currentMediaId = btn.dataset.mediaId;
      const isShift = event.shiftKey;
      stopSelectionEvent(event);
      // Pointer activation was handled on pointerup so a card can never see
      // the gesture. Keyboard and assistive-technology clicks still arrive here.
      if (Date.now() < suppressClickUntil) return;
      toggleCardSelection(selectionButtonCards.get(btn) || { mediaId: currentMediaId }, isShift);
    }, { capture: true });
    return btn;
  }

  function scheduleGridDecoration() {
    if (selectionUpdateScheduled) return;
    selectionUpdateScheduled = true;
    const schedule = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    schedule(() => {
      selectionUpdateScheduled = false;
      decorateGridTiles();
    });
  }

  function visibleTileRect(tile) {
    const original = tile.getBoundingClientRect();
    const rect = {
      top: Math.max(0, original.top),
      left: Math.max(0, original.left),
      right: Math.min(window.innerWidth, original.right),
      bottom: Math.min(window.innerHeight, original.bottom),
    };
    for (let current = tile.parentElement; current && current !== document.body; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (!/(?:auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) continue;
      const clip = current.getBoundingClientRect();
      rect.top = Math.max(rect.top, clip.top);
      rect.left = Math.max(rect.left, clip.left);
      rect.right = Math.min(rect.right, clip.right);
      rect.bottom = Math.min(rect.bottom, clip.bottom);
    }
    return {
      ...rect,
      original,
      width: Math.max(0, rect.right - rect.left),
      height: Math.max(0, rect.bottom - rect.top),
    };
  }

  function toggleCardSelection(card, isShift = false) {
    if (!card?.mediaId) return;
    const mediaId = card.mediaId;

    if (isShift && lastSelectedMediaId && modernInventoryCache?.videos) {
      const videos = modernInventoryCache.videos;
      const idx1 = videos.findIndex((v) => v.mediaId === lastSelectedMediaId);
      const idx2 = videos.findIndex((v) => v.mediaId === mediaId);
      if (idx1 !== -1 && idx2 !== -1) {
        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        const shouldSelect = !selectedMediaIds.has(mediaId);
        for (let i = start; i <= end; i += 1) {
          if (shouldSelect) selectedMediaIds.add(videos[i].mediaId);
          else selectedMediaIds.delete(videos[i].mediaId);
        }
        if (card.tile) {
          if (shouldSelect) tileSelectionAnchors.set(card.tile, { mediaId, title: card.title || "", selectedAt: Date.now() });
          else tileSelectionAnchors.delete(card.tile);
        }
      }
    } else {
      if (selectedMediaIds.has(mediaId)) {
        selectedMediaIds.delete(mediaId);
        if (card.tile) tileSelectionAnchors.delete(card.tile);
      } else {
        selectedMediaIds.add(mediaId);
        if (card.tile) tileSelectionAnchors.set(card.tile, { mediaId, title: card.title || "", selectedAt: Date.now() });
      }
      lastSelectedMediaId = mediaId;
    }

    updateAllDecoratedButtons();
    updateFloatingDock();
  }

  function identityStrength(mediaId) {
    if (mediaId?.startsWith("flow-media:")) return 3;
    if (mediaId?.startsWith("flow-tile:")) return 2;
    if (mediaId?.startsWith("flow-label:")) return 1;
    return 0;
  }

  function reconcileLoadedCardIdentity(card) {
    const previousMediaId = tileMediaIds.get(card.tile);
    tileMediaIds.set(card.tile, card.mediaId);
    if (!previousMediaId || previousMediaId === card.mediaId) return;
    if (!selectedMediaIds.has(previousMediaId)) return;
    const anchor = tileSelectionAnchors.get(card.tile);
    const recentClickOnSameCard = anchor?.mediaId === previousMediaId
      && Date.now() - anchor.selectedAt < 15_000
      && (!anchor.title || !card.title || anchor.title === card.title);
    if (!recentClickOnSameCard && identityStrength(card.mediaId) <= identityStrength(previousMediaId)) return;

    selectedMediaIds.delete(previousMediaId);
    selectedMediaIds.add(card.mediaId);
    if (recentClickOnSameCard) {
      tileSelectionAnchors.set(card.tile, { ...anchor, mediaId: card.mediaId });
    }
    if (lastSelectedMediaId === previousMediaId) lastSelectedMediaId = card.mediaId;
    for (const video of modernInventoryCache?.videos || []) {
      if (video.mediaId === previousMediaId) video.mediaId = card.mediaId;
    }
    log(`Updated selected video identity after Flow finished loading its card.`);
  }

  function decorateGridTiles() {
    if (!usesModernFlow() || typeof document === "undefined") return;
    ensureGridSelectionStyles();
    const layer = ensureSelectionLayer();
    layer.hidden = state.running;
    if (state.running) return;
    if (!selectionListenersAttached) {
      document.addEventListener("scroll", () => {
        tileSelectionAnchors = new WeakMap();
        scheduleGridDecoration();
      }, { capture: true, passive: true });
      window.addEventListener("resize", scheduleGridDecoration, { passive: true });
      selectionListenersAttached = true;
    }

    // Remove controls injected by an older content-script instance. Keeping
    // controls outside Flow's tiles prevents the app's pointer handlers from
    // treating a selection click as a request to play the video.
    for (const stale of document.querySelectorAll(".flow-exporter-select-btn")) {
      if (stale.parentElement !== layer) stale.remove();
    }

    const cards = Modern.videoCards(document, location.href, () => true);
    const visibleIds = new Set();
    for (const card of cards) {
      if (!card.tile) continue;
      const rect = visibleTileRect(card.tile);
      if (rect.width < 28 || rect.height < 28) continue;

      reconcileLoadedCardIdentity(card);

      visibleIds.add(card.mediaId);
      let btn = selectionButtons.get(card.mediaId);
      if (!btn) {
        btn = createSelectionButton(card.mediaId);
        selectionButtons.set(card.mediaId, btn);
        layer.append(btn);
      }
      btn.dataset.mediaId = card.mediaId;
      selectionButtonCards.set(btn, card);
      btn.style.left = `${Math.round(Math.max(rect.left + 4, rect.original.left + 8))}px`;
      btn.style.top = `${Math.round(Math.max(rect.top + 4, rect.original.top + 8))}px`;
      const isSelected = selectedMediaIds.has(card.mediaId);
      btn.classList.toggle("selected", isSelected);
      btn.setAttribute("aria-pressed", String(isSelected));
      btn.setAttribute("aria-label", `${isSelected ? "Deselect" : "Select"} ${card.title || "video"} for export`);
    }

    for (const [mediaId, btn] of selectionButtons) {
      if (visibleIds.has(mediaId)) continue;
      btn.remove();
      selectionButtons.delete(mediaId);
    }
  }

  function snapshotState() {
    return {
      ...state,
      failures: state.failures.map((failure) => ({ ...failure })),
      logs: [...activityLogs],
    };
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
    log(`[#${index}] FAILED: "${title}" — ${message}`);
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
      return Modern.videoCards(document, location.href, visibleOnly ? isVisible : () => true);
    }
    const cards = new Map();
    for (const image of document.querySelectorAll('img[src*="getMediaUrlRedirect"]')) {
      if (visibleOnly && !isVisible(image)) continue;
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
    if (usesModernFlow()) return;
    const candidates = visibleElements("[role='tab'], button, [role='button'], a, [role='link']");
    const label = (element) => Core.compactText(element.getAttribute("aria-label") || element.textContent)
      .replace(/^(?:videocam|video_library|dashboard)\s*/i, "");
    const videos = candidates.find((element) => /^videos(?:\s*\(?\d+\)?)?$/i.test(label(element)));
    const allMedia = candidates.find((element) => /^all media$/i.test(label(element)));
    const target = videos;
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
      const response = await sendRuntimeMessage({
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
    const response = await sendRuntimeMessage({
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
      document.documentElement.scrollTop = value;
      document.body.scrollTop = value;
    } else {
      container.scrollTop = value;
      try {
        container.scrollTo({ top: value, behavior: "instant" });
      } catch {}
    }
    try {
      container.dispatchEvent(new Event("scroll", { bubbles: true }));
    } catch {}
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

  async function closeActiveMenus() {
    try {
      for (const v of document.querySelectorAll("video")) {
        if (!v.paused) v.pause();
      }
    } catch {}

    const dialogs = visibleElements("[role='dialog'], .mat-mdc-dialog-container");
    for (const dialog of dialogs) {
      const closeBtn = dialog.querySelector("button[aria-label*='close' i], button.close-button");
      if (closeBtn && isVisible(closeBtn)) {
        try { closeBtn.click(); } catch {}
      }
    }

    const active = document.activeElement;
    if (active && active !== document.body) {
      active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
      active.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true }));

    const backdrops = [...document.querySelectorAll(".cdk-overlay-backdrop")].filter(isVisible);
    for (const backdrop of backdrops) {
      const rect = backdrop.getBoundingClientRect();
      const safeX = Math.max(50, Math.floor(rect.width * 0.95));
      const safeY = 20;
      backdrop.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: safeX,
        clientY: safeY,
      }));
    }

    const snackbarDismiss = visibleElements(".mat-mdc-snack-bar-container button, .mat-mdc-snack-bar-action");
    for (const btn of snackbarDismiss) {
      try { btn.click(); } catch {}
    }

    await waitFor(() => !getActiveMenuPanel(), 500, 50);
  }

  function getActiveMenuPanel() {
    const panels = visibleElements(".cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-menu-panel, [role='menu']");
    return panels.find((panel) => {
      const style = getComputedStyle(panel);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0.05) return false;
      return Boolean(panel.querySelector("[role='menuitem'], .mat-mdc-menu-item, flow-menu-item, button"));
    }) || null;
  }

  async function openAssetMenu(target) {
    await closeActiveMenus();

    const tile = target.closest("flow-grid-tile-container") || target.parentElement || target;
    tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await sleep(200);

    const tileRect = tile.getBoundingClientRect();
    const centerX = Math.max(10, Math.floor(tileRect.left + tileRect.width / 2));
    const centerY = Math.max(10, Math.floor(tileRect.top + tileRect.height / 2));

    // 1. First attempt: contextmenu (right-click) on tile / media. This opens the asset menu
    // in both real Flow and mock tests without triggering video preview playback.
    const contextInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 2,
      buttons: 2,
      clientX: centerX,
      clientY: centerY,
    };
    const media = tile.querySelector("flow-video-tile") || tile.querySelector("video")?.parentElement || tile;
    for (const el of [tile, media]) {
      el.dispatchEvent(new MouseEvent("contextmenu", contextInit));
      if (typeof PointerEvent !== "undefined") {
        el.dispatchEvent(new PointerEvent("contextmenu", contextInit));
      }
    }

    let menu = await waitFor(getActiveMenuPanel, 400, 50);
    if (menu) {
      await sleep(150);
      return true;
    }

    // 2. Second attempt: hover the tile container (NOT the video tile itself to avoid autoplay)
    // and click the 3-dots options menu button.
    const hoverInit = {
      bubbles: true,
      view: window,
      clientX: centerX,
      clientY: centerY,
    };
    tile.dispatchEvent(new MouseEvent("mouseenter", hoverInit));
    tile.dispatchEvent(new MouseEvent("mouseover", hoverInit));
    if (typeof PointerEvent !== "undefined") {
      tile.dispatchEvent(new PointerEvent("pointerenter", hoverInit));
      tile.dispatchEvent(new PointerEvent("pointerover", hoverInit));
    }

    const findMoreButton = () => {
      const candidates = visibleElements(
        "button[aria-label*='options' i], button[aria-label*='more' i], button.mat-mdc-menu-trigger, button[aria-haspopup='menu']",
        tile,
      );
      return candidates.find((b) => {
        const text = elementText(b);
        if (/\b(play|preview)\b/i.test(text)) return false;
        return /(?:more_vert|\bmore\b|\boptions?\b)/i.test(text)
          || b.classList.contains("mat-mdc-menu-trigger")
          || b.getAttribute("aria-haspopup") === "menu";
      }) || tile.querySelector("button[aria-label*='options' i], button[aria-label*='more' i], button.mat-mdc-menu-trigger, button[aria-haspopup='menu']");
    };

    let moreButton = findMoreButton();
    if (!moreButton) {
      await sleep(150);
      moreButton = findMoreButton();
    }
    if (!moreButton) {
      const surface = tile.querySelector("flow-video-tile") || target;
      surface.dispatchEvent(new MouseEvent("contextmenu", contextInit));
      menu = await waitFor(getActiveMenuPanel, 800, 80);
      return Boolean(menu);
    }

    let rect = moreButton.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1 || rect.top < 0 || rect.bottom > window.innerHeight) {
      tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await sleep(150);
      rect = moreButton.getBoundingClientRect();
    }

    const clickInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.max(10, Math.floor(rect.left + rect.width / 2)),
      clientY: Math.max(10, Math.floor(rect.top + rect.height / 2)),
      button: 0,
    };

    moreButton.focus?.();
    moreButton.dispatchEvent(new MouseEvent("mouseenter", clickInit));
    moreButton.dispatchEvent(new MouseEvent("mousedown", clickInit));
    moreButton.dispatchEvent(new MouseEvent("mouseup", clickInit));
    moreButton.click();

    menu = await waitFor(getActiveMenuPanel, 1_500, 80);
    if (!menu) {
      tile.dispatchEvent(new MouseEvent("contextmenu", contextInit));
      menu = await waitFor(getActiveMenuPanel, 1_000, 80);
    }

    await sleep(200);
    return Boolean(menu);
  }

  function resolutionCandidates() {
    const selector = [
      "[role='menuitem']",
      "[role='menuitemradio']",
      "[role='option']",
      "[role='radio']",
      ".mat-mdc-menu-item",
      "button",
      "flow-menu-item",
      ".item-text",
      ".label",
      "[data-value]",
      "[data-resolution]",
    ].join(", ");
    const seen = new Set();
    const roots = visibleElements(".cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-menu-panel, .cdk-overlay-pane, [role='menu']");
    if (!roots.length) return [];

    const candidates = roots.flatMap((root) => visibleElements(selector, root));
    return candidates
      .filter((element) => {
        const text = elementText(element);
        if (!/\b(?:\d{3,4}p|[48]k|[124]x|original|upscaled?)\b/i.test(text) && !/\bupscal/i.test(text)) return false;
        const clickable = element.matches?.("button, [role='menuitem']")
          ? element
          : (element.closest?.("button, [role='menuitem']") || element.querySelector?.("button, [role='menuitem']") || element);
        if (seen.has(clickable)) return false;
        seen.add(clickable);
        return true;
      })
      .map((element) => {
        const clickable = element.matches?.("button, [role='menuitem']")
          ? element
          : (element.closest?.("button, [role='menuitem']") || element.querySelector?.("button, [role='menuitem']") || element);
        return {
          element: clickable,
          text: elementText(clickable) || elementText(element),
          disabled: Core.isDisabledElement(clickable),
        };
      });
  }

  async function exposeDownloadChoices(quality, originalHeight) {
    const choicesVisible = () => Boolean(
      Core.selectResolutionCandidate(resolutionCandidates(), quality, originalHeight),
    );
    if (choicesVisible()) return true;

    const menuRoots = visibleElements(".cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-menu-panel, .cdk-overlay-pane, [role='menu']");
    if (!menuRoots.length) return false;

    const menuItems = menuRoots.flatMap((root) =>
      visibleElements("[role='menuitem'], .mat-mdc-menu-item, flow-menu-item, button, .label, .item-text", root),
    );

    const downloadTarget = menuItems.find((item) => {
      const text = elementText(item);
      if (quality === "1080p" && /\bupscal/i.test(text)) return true;
      return /^download(?:\b|$)/i.test(text) || /(?:^|\s)download(?:\s|$)/i.test(text);
    });
    if (!downloadTarget) return choicesVisible();

    const downloadButton = downloadTarget.matches?.("button, [role='menuitem']")
      ? downloadTarget
      : (downloadTarget.closest?.("button, [role='menuitem']")
         || downloadTarget.querySelector?.("button, [role='menuitem']")
         || downloadTarget);

    const rect = downloadButton.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };

    downloadButton.focus?.();
    downloadButton.dispatchEvent(new MouseEvent("mouseenter", eventInit));
    downloadButton.dispatchEvent(new MouseEvent("mouseover", eventInit));
    if (typeof PointerEvent !== "undefined") {
      downloadButton.dispatchEvent(new PointerEvent("pointerenter", eventInit));
      downloadButton.dispatchEvent(new PointerEvent("pointerover", eventInit));
    }

    if (await waitFor(choicesVisible, 600, 80)) return true;

    downloadButton.dispatchEvent(new MouseEvent("mousedown", eventInit));
    downloadButton.dispatchEvent(new MouseEvent("mouseup", eventInit));
    downloadButton.click?.();

    if (await waitFor(choicesVisible, 1_000, 80)) return true;

    // Use ArrowRight to open submenu in menus that support keyboard navigation
    downloadButton.focus?.();
    downloadButton.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
      bubbles: true,
      cancelable: true,
    }));
    downloadButton.dispatchEvent(new KeyboardEvent("keyup", {
      key: "ArrowRight",
      code: "ArrowRight",
      keyCode: 39,
      bubbles: true,
      cancelable: true,
    }));
    if (await waitFor(choicesVisible, 600, 80)) return true;

    return choicesVisible();
  }

  function findResolutionChoice(quality, originalHeight) {
    return Core.selectResolutionCandidate(resolutionCandidates(), quality, originalHeight);
  }

  function visibleResolutionSummary() {
    const directLabels = resolutionCandidates().map((candidate) => candidate.text);
    if (directLabels.length) return [...new Set(directLabels)].slice(0, 8).join(" | ");
    const roots = visibleElements(".cdk-overlay-container .mat-mdc-menu-panel, .cdk-overlay-pane .mat-mdc-menu-panel, [role='menu']");
    if (!roots.length) return "";
    const fallbackItems = roots.flatMap((root) => visibleElements("[role='menuitem'], .mat-mdc-menu-item, flow-menu-item, .label, button", root));
    const fallbackLabels = fallbackItems.map((el) => Core.compactText(el.innerText || el.textContent)).filter((t) => t.length > 0 && t.length < 50);
    return [...new Set(fallbackLabels)].slice(0, 10).join(" | ");
  }

  async function confirmFlowDialog() {
    const findConfirm = () => {
      const dialogs = visibleElements("[role='dialog'], .mat-mdc-dialog-container");
      for (const dialog of dialogs) {
        const buttons = visibleElements("button, [role='button']", dialog)
          .filter((button) => !Core.isDisabledElement(button));
        const confirm = buttons.find((button) =>
          /\b(upscale|download|confirm|continue|start|generate|export|proceed|credit|ok|yes)\b/i.test(elementText(button)),
        ) || buttons.find((button) =>
          !/\b(cancel|close|dismiss|back|no)\b/i.test(elementText(button))
          && (button.classList.contains("mat-primary") || button.getAttribute("color") === "primary" || button.classList.contains("mat-mdc-unelevated-button")),
        );
        if (confirm) return confirm;
      }
      return null;
    };
    const button = findConfirm();
    if (button) {
      const rect = button.getBoundingClientRect();
      const clickInit = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      button.focus?.();
      button.dispatchEvent(new MouseEvent("mousedown", clickInit));
      button.dispatchEvent(new MouseEvent("mouseup", clickInit));
      button.click();
      log("Auto-confirmed Flow dialog.");
      await sleep(300);
      return true;
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

    const ready = sendRuntimeMessage({
      type: "FLOW_WATCH_DOWNLOAD",
      token,
      subfolder: activeSubfolder,
    }).catch(() => ({ ok: false }));
    return { promise, ready };
  }

  function cancelDownloadWatch(token) {
    if (pendingDownload?.token === token) {
      pendingDownload.resolve({ kind: "cancelled" });
      pendingDownload = null;
    }
    void sendRuntimeMessage({ type: "FLOW_CANCEL_DOWNLOAD_WATCH", token }).catch(() => undefined);
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
      const response = await sendRuntimeMessage({
        type: "FLOW_DIRECT_DOWNLOAD",
        url,
        filename,
        subfolder: activeSubfolder,
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
    const response = await sendRuntimeMessage({
      type: "FLOW_DOWNLOAD_MEDIA",
      mediaId,
      filename,
      subfolder: activeSubfolder,
    });
    if (!response?.ok) throw new Error(response?.error || "Chrome could not start the Flow download.");
    await waitForDownloadCompletion(response.downloadId);
    return response.downloadId;
  }

  async function waitForDownloadCompletion(downloadId) {
    const deadline = Date.now() + DOWNLOAD_TIMEOUT["720p"];
    while (!state.stopRequested && Date.now() < deadline) {
      const result = await sendRuntimeMessage({ type: "FLOW_DOWNLOAD_STATUS", downloadId });
      if (!result?.ok) throw new Error(result?.error || "Chrome could not check the download.");
      if (result.state === "complete") return;
      if (result.state === "interrupted") throw new Error(`Download interrupted: ${result.error || "unknown error"}. Retry this video.`);
      await sleep(500);
    }
    throw new Error(state.stopRequested ? "Export stopped." : "Download has not completed. Check Chrome Downloads before retrying.");
  }

  function visibleFailureMessage() {
    const containers = visibleElements(".mat-mdc-snack-bar-container, [role='alertdialog'], [role='alert']:not(button), [role='dialog'] .error-message");
    for (const container of containers) {
      let text = elementText(container);
      const buttons = [...container.querySelectorAll("button, [role='button']")];
      for (const btn of buttons) {
        text = text.replace(elementText(btn), " ");
      }
      text = Core.compactText(text);
      if (!text) continue;
      // Skip informational or successful media download toasts
      if (/^download\s+media\b/i.test(text) && !/\b(?:failed|error|unable)\b/i.test(text)) continue;

      const match = text.match(
        /(?:upscal|download|export).{0,60}(?:has failed|failed to|failed\b|unable to)/i,
      ) || text.match(
        /(?:failed to|couldn.?t|unable to|error\s+(?:while|during|generating))\s+(?:upscal|download|export)/i,
      );
      if (match) return Core.compactText(match[0]).slice(0, 220);
    }
    return "";
  }

  async function waitForUpscaleFailure(timeoutMs) {
    return waitFor(() => {
      const message = visibleFailureMessage();
      return message ? { kind: "flow-failure", message } : null;
    }, timeoutMs, 500);
  }

  async function exportMediaCard(card, quality, index, title = "") {
    if (!card.surface?.isConnected || !card.tile?.isConnected) {
      const fresh = findTileForVideo({ title, mediaId: card.mediaId });
      if (fresh) card = fresh;
    }
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
    log(`[#${index}] Opening Flow menu for "${title || card.mediaId}"…`);
    const menuOpened = await openAssetMenu(card.tile || surface);
    if (!menuOpened) throw new Error("Could not open this video’s Flow menu.");

    await exposeDownloadChoices(quality, video?.videoHeight || 0);
    const choice = await waitFor(() => findResolutionChoice(quality, video?.videoHeight || 0), 3_500);
    if (!choice) {
      const summary = visibleResolutionSummary();
      await closeActiveMenus();
      log(`[#${index}] ${quality} option not found. Flow menu showed: ${summary || "none"}`);
      throw new Error(
        `${quality} is not available for this video or account.${summary ? ` Flow showed: ${summary}` : ""}`,
      );
    }

    if (choice.disabled) throw new Error(`${quality} is disabled for this video or account.`);

    const choiceLabel = choice.text || quality;
    const isAlreadyUpscaled = quality === "720p" || /\bupscaled\b/i.test(choiceLabel);
    log(`[#${index}] Selected option "${choiceLabel}". Initiating export…`);

    const token = `${quality}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const downloadWatch = beginDownloadWatch(token, DOWNLOAD_TIMEOUT[quality]);
    const ready = await downloadWatch.ready;
    if (!ready?.ok) {
      cancelDownloadWatch(token);
      throw new Error(ready?.error || "Chrome could not monitor the download. Reload the extension and Flow tab.");
    }
    const existingFailure = visibleFailureMessage();
    const choiceRect = choice.element.getBoundingClientRect();
    const choiceEventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.max(10, Math.floor(choiceRect.left + choiceRect.width / 2)),
      clientY: Math.max(10, Math.floor(choiceRect.top + choiceRect.height / 2)),
      button: 0,
    };
    choice.element.focus?.();
    choice.element.dispatchEvent(new MouseEvent("mouseenter", choiceEventInit));
    choice.element.dispatchEvent(new MouseEvent("mousedown", choiceEventInit));
    choice.element.dispatchEvent(new MouseEvent("mouseup", choiceEventInit));
    choice.element.click();
    await confirmFlowDialog();
    await closeActiveMenus();

    if (card.nativeMenu) {
      const startTime = Date.now();
      const deadline = Date.now() + DOWNLOAD_TIMEOUT[quality];
      let lastCheckTime = 0;
      let lastMenuPollTime = 0;
      let downloadInitiated = isAlreadyUpscaled;
      let watcherDone = false;

      const watcher = (async () => {
        while (!watcherDone && !state.stopRequested && Date.now() < deadline) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          state.message = downloadInitiated
            ? `${quality}: downloading video ${index} (${elapsed}s)…`
            : `${quality}: upscaling video ${index} (${elapsed}s) — waiting for Flow…`;

          await confirmFlowDialog();
          const failure = visibleFailureMessage();
          if (failure && failure !== existingFailure) {
            return { kind: "flow-failure", message: failure };
          }

          if (Date.now() - lastCheckTime > 2_000) {
            lastCheckTime = Date.now();
            const check = await sendRuntimeMessage({
              type: "FLOW_CHECK_DOWNLOAD_WATCH",
              token,
            }).catch(() => null);
            if (check?.matched && check.state === "complete") {
              return { kind: "download" };
            }
            if (check?.matched && check.state === "interrupted") {
              return { kind: "flow-failure", message: "Chrome download was interrupted." };
            }
            if (check?.matched && check.state === "in_progress") {
              downloadInitiated = true;
            }
          }

          if (!downloadInitiated && elapsed >= 6 && Date.now() - lastMenuPollTime > 5_000) {
            lastMenuPollTime = Date.now();
            const freshCard = findTileForVideo({ title, mediaId: card.mediaId }) || card;
            const freshSurface = freshCard.tile || freshCard.surface;
            const hasSpinner = Boolean(freshSurface?.querySelector?.("mat-progress-spinner, mat-spinner, flow-pending-tile, .spinner, [role='progressbar']"));

            if (!hasSpinner) {
              const menuCheckOpened = await openAssetMenu(freshSurface);
              if (menuCheckOpened) {
                await exposeDownloadChoices(quality, video?.videoHeight || 0);
                const nextChoice = findResolutionChoice(quality, video?.videoHeight || 0);
                if (nextChoice && !nextChoice.disabled) {
                  const nextText = (nextChoice.text || "").toLowerCase();
                  if (nextText.includes("upscal") || nextText.includes("1080p")) {
                    log(`[#${index}] Flow finished upscaling. Clicking "${nextChoice.text}" to download 1080p…`);
                    nextChoice.element.click();
                    downloadInitiated = true;
                    await confirmFlowDialog();
                    await closeActiveMenus();
                  }
                } else {
                  await closeActiveMenus();
                }
              }
            }
          }

          await sleep(700);
        }

        if (state.stopRequested) return { kind: "cancelled", message: "Export stopped." };
        return { kind: "timeout", message: `Flow did not complete the ${quality} download within 5 minutes. Check Flow's message and Chrome Downloads, then retry this video.` };
      })();

      try {
        const result = await Promise.race([downloadWatch.promise, watcher]);
        if (result.kind === "download") {
          log(`[#${index}] Download confirmed successfully.`);
          return { filename: result.filename || "" };
        }
        throw new Error(result.message || "Download failed.");
      } finally {
        watcherDone = true;
        cancelDownloadWatch(token);
        await closeActiveMenus();
      }
    }

    if (quality === "720p") {
      const result = await downloadWatch.promise;
      if (result.kind === "download") return { filename: result.filename || "" };
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

    if (result.kind === "download") return { filename: result.filename || "" };
    if (result.kind === "flow-failure" || result.kind === "download-failure") {
      cancelDownloadWatch(token);
      throw new Error(result.message);
    }
    if (result.kind === "new-media" && result.newMedia?.kind === "media-id") {
      cancelDownloadWatch(token);
      const label = mediaLabel(surface, index, quality, title);
      await directDownloadMediaId(result.newMedia.mediaId, label);
      return { filename: label };
    }
    if (result.kind === "new-media" && result.newMedia?.kind === "video") {
      cancelDownloadWatch(token);
      const label = mediaLabel(surface, index, quality, title);
      await directDownloadVideo(result.newMedia.video, label);
      return { filename: label };
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

  function findTileForVideo(video) {
    if (!video) return null;
    const cards = Modern.videoCards(document, location.href, () => true);

    if (video.mediaId) {
      const matchById = cards.find((c) => c.mediaId === video.mediaId);
      if (matchById) return matchById;

      if (video.mediaId.startsWith("flow-label:") && video.mediaId.length > 13) {
        const targetLabel = video.mediaId.slice("flow-label:".length);
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
          if (tile.getAttribute("aria-label") === targetLabel) {
            const media = tile.querySelector("flow-video-tile") || tile.querySelector("video")?.parentElement || tile;
            return {
              mediaId: video.mediaId,
              title: video.title || targetLabel,
              tile,
              surface: media,
              video: tile.querySelector("video"),
              nativeMenu: true,
            };
          }
        }
      }
      return null;
    }

    if (video.title && video.title.length >= 4) {
      const normTarget = normalizedTitle(video.title);
      const matchByTitle = cards.find((c) => normalizedTitle(c.title) === normTarget);
      if (matchByTitle) return matchByTitle;

      for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
        const text = normalizedTitle(elementText(tile));
        if (text && text === normTarget) {
          const media = tile.querySelector("flow-video-tile") || tile.querySelector("video")?.parentElement || tile;
          return {
            mediaId: video.mediaId,
            title: video.title,
            tile,
            surface: media,
            video: tile.querySelector("video"),
            nativeMenu: true,
          };
        }
      }
    }

    return null;
  }

  async function findAndMountCardForVideo(video, scrollContainer) {
    let card = findTileForVideo(video);
    if (card && card.surface?.isConnected && card.tile?.isConnected) {
      card.tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await sleep(150);
      return findTileForVideo(video) || card;
    }

    if (!scrollContainer) {
      const seed = document.querySelector("flow-grid-tile-container");
      scrollContainer = seed ? findScrollableAncestor(seed) : document.scrollingElement;
    }

    const metrics = () => scrollMetrics(scrollContainer);
    const stepSize = Math.max(180, Math.min(260, Math.floor(metrics().viewport * 0.3)));

    // If scroll offset > 0, scan upwards towards top first
    if (metrics().top > 0) {
      let upwardsPasses = 0;
      while (!state.stopRequested && upwardsPasses < 60) {
        const m = metrics();
        upwardsPasses += 1;

        setScrollTop(scrollContainer, Math.max(0, m.top - stepSize));
        await sleep(150);

        card = findTileForVideo(video);
        if (card && card.surface?.isConnected && card.tile?.isConnected) {
          card.tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
          await sleep(150);
          return findTileForVideo(video) || card;
        }

        if (m.top <= 0) break;
      }
    }

    // Now scan downwards towards bottom
    let lastTop = -1;
    let downwardsPasses = 0;
    while (!state.stopRequested && downwardsPasses < 60) {
      const m = metrics();
      const atBottom = m.top + m.viewport >= m.height - 10;
      if (lastTop !== -1 && Math.abs(m.top - lastTop) < 2) break;
      if (atBottom && downwardsPasses > 0) break;
      lastTop = m.top;
      downwardsPasses += 1;

      setScrollTop(scrollContainer, Math.min(m.height - m.viewport, m.top + stepSize));
      await sleep(150);

      card = findTileForVideo(video);
      if (card && card.surface?.isConnected && card.tile?.isConnected) {
        card.tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        await sleep(150);
        return findTileForVideo(video) || card;
      }
    }

    // Final check at current position
    card = findTileForVideo(video);
    if (card && card.surface?.isConnected && card.tile?.isConnected) {
      card.tile.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      await sleep(150);
      return findTileForVideo(video) || card;
    }

    return null;
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
    let lastScrollTop = -1;
    let unmovedRounds = 0;

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

        const metrics = scrollMetrics(scrollContainer);
        const atBottom = metrics.top + metrics.viewport >= metrics.height - 12;
        if (Math.abs(metrics.top - lastScrollTop) < 4) {
          unmovedRounds += 1;
        } else {
          unmovedRounds = 0;
          lastScrollTop = metrics.top;
        }

        if (atBottom && stableRounds >= 2) break;
        if (stableRounds >= 4 && unmovedRounds >= 2) break;
        if (stableRounds >= 6) break;
        if (!atBottom) {
          const stepSize = Math.max(180, Math.min(260, Math.floor(metrics.viewport * 0.3)));
          const nextTop = Math.min(
            Math.max(0, metrics.height - metrics.viewport),
            metrics.top + stepSize,
          );
          setScrollTop(scrollContainer, nextTop);
        }
        scrollContainer.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        if (!usesModernFlow()) window.scrollTo({
          top: Math.min(
            window.scrollY + Math.max(180, Math.floor(window.innerHeight * 0.3)),
            Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
          ),
          behavior: "instant",
        });
        await sleep(atBottom ? 400 : SCROLL_WAIT_MS);
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
      if (!force && modernInventoryCache && (Date.now() - modernInventoryCache.loadedAt < 60_000)) {
        return modernInventoryCache.videos;
      }
      const videos = [];
      state.message = "Scanning Flow's current video grid…";
      await walkMediaGrid(null, async (card) => {
        videos.push({ mediaId: card.mediaId, title: card.title, nativeMenu: true });
        state.found = videos.length;
        state.message = `Scanning Flow's video grid — ${videos.length} videos found…`;
      });
      modernInventoryCache = { videos, loadedAt: Date.now() };
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
      startTime: mode === "Scan" ? null : Date.now(),
      elapsed: "00:00",
      eta: "--:--",
      speed: "--",
      projectTitle: getProjectTitle(),
      failures: [],
      message: mode === "Scan" ? "Scanning project…" : `Preparing ${quality} export…`,
      lastError: "",
    });
  }

  function updateTimingStats(totalCount) {
    if (!state.startTime) return;
    const now = Date.now();
    const elapsedMs = Math.max(0, now - state.startTime);
    state.elapsed = Core.formatDuration(elapsedMs);
    const finishedCount = state.success + state.failed;
    if (finishedCount > 0) {
      const avgMs = elapsedMs / finishedCount;
      const remainingCount = Math.max(0, totalCount - state.processed);
      state.eta = Core.formatDuration(avgMs * remainingCount);
      state.speed = `${Math.round(avgMs / 1000)}s/item`;
    }
  }

  async function scanProject() {
    if (state.running) return;
    resetState("Scan");
    log("Starting Flow project scan…");
    try {
      const videos = await resolveVideoInventory(true);
      state.found = videos.length;
      state.processed = videos.length;
      state.message = state.stopRequested
        ? `Scan stopped after ${state.found} videos`
        : `Found ${state.found} videos`;
      log(state.message);
    } catch (error) {
      state.failed += 1;
      state.lastError = error.message;
      state.message = error.message;
      log(`Scan failed: ${error.message}`);
    } finally {
      state.running = false;
      state.mode = "Idle";
    }
  }

  async function runBatch(quality, requestedFailures = null, options = {}) {
    if (state.running) return;
    let organizeSubfolders = options.organizeSubfolders;
    let customFolder = options.customFolder;
    if (organizeSubfolders === undefined || customFolder === undefined) {
      try {
        const saved = await chrome.storage.local.get(["organizeSubfolders", "customFolder"]);
        if (organizeSubfolders === undefined) organizeSubfolders = saved?.organizeSubfolders;
        if (customFolder === undefined) customFolder = saved?.customFolder;
      } catch {}
    }
    if (state.running) return;
    activeSubfolder = organizeSubfolders === false
      ? ""
      : Core.sanitizeFolderPath(customFolder || "Flow Videos", "Flow Videos");
    resetState(quality === "720p" ? "720p export" : "1080p upscale", quality);
    const folderLabel = activeSubfolder ? `Downloads/${activeSubfolder}/` : "Downloads/";
    log(`Batch export started: quality=${quality}, folder=${folderLabel}, target=${requestedFailures?.length ? `${requestedFailures.length} failed videos` : "all videos"}`);

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
      } else if (options.selectedMediaIds?.length) {
        const idSet = new Set(options.selectedMediaIds);
        videos = completeInventory.filter((video) => idSet.has(video.mediaId));
        log(`Selection applied: ${videos.length}/${completeInventory.length} videos chosen from grid.`);
      }
      state.found = videos.length;
      log(`Inventory resolved: ${videos.length} videos queued for ${quality}.`);

      if (quality === "720p" && !usesModernFlow()) {
        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {
          const video = videos[index];
          const videoTitle = video.title || video.mediaId || `Video ${index + 1}`;
          log(`[#${index + 1}/${videos.length}] Direct downloading "${videoTitle}"…`);
          state.message = `720p: downloading video ${index + 1}/${videos.length}…`;
          try {
            await directDownloadMediaId(
              video.mediaId,
              mediaLabel(null, index + 1, quality, video.title),
            );
            state.success += 1;
            log(`[#${index + 1}/${videos.length}] Direct download started: "${videoTitle}"`);
          } catch (error) {
            state.failed += 1;
            recordFailure(video, index + 1, error);
          } finally {
            state.processed += 1;
            updateTimingStats(videos.length);
            await sleep(120);
          }
        }
      } else if (usesModernFlow()) {
        if (!videos.length) {
          state.message = state.stopRequested ? "Scan stopped." : "No completed videos were found in this Flow view.";
          log(state.message);
          return;
        }
        state.message = `${quality}: preparing export for ${videos.length} videos…`;
        const scrollContainer = findScrollableAncestor(document.querySelector("flow-grid-tile-container")) || document.scrollingElement;

        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {
          const video = videos[index];
          const videoTitle = video.title || video.mediaId || `Video ${index + 1}`;
          log(`[#${index + 1}/${videos.length}] Locating "${videoTitle}" in grid…`);
          state.message = `${quality}: locating video ${index + 1}/${videos.length}…`;

          try {
            const card = await findAndMountCardForVideo(video, scrollContainer);
            if (!card) {
              throw new Error(`Video card "${video.title || video.mediaId}" was not found in Flow's grid.`);
            }

            log(`[#${index + 1}/${videos.length}] Found card in grid. Exporting "${videoTitle}"…`);
            state.message = `${quality}: processing video ${index + 1}/${videos.length}…`;
            await exportMediaCard(card, quality, index + 1, video.title || "");
            state.success += 1;
            state.message = `${quality}: video ${index + 1}/${videos.length} completed`;
            log(`[#${index + 1}/${videos.length}] Completed "${videoTitle}"`);
          } catch (error) {
            state.failed += 1;
            recordFailure(video, index + 1, error);
            state.message = `${quality}: ${error.message}`;
          } finally {
            state.processed += 1;
            updateTimingStats(videos.length);
            await closeActiveMenus();
            await sleep(800);
          }
        }
      } else {
        if (!videos.length) {
          state.message = state.stopRequested ? "Scan stopped." : "No completed videos were found in this Flow view.";
          log(state.message);
          return;
        }
        state.message = `${quality}: preparing export for ${videos.length} videos…`;
        const targetById = new Map(videos.map((video) => [video.mediaId, video]));
        const walkResult = await walkMediaGrid(targetById, async (card, matchIndex, video) => {
          const videoTitle = video?.title || video?.mediaId || `Video ${state.processed + 1}`;
          log(`[#${state.processed + 1}/${videos.length}] Exporting "${videoTitle}"…`);
          state.message = `${quality}: processing video ${state.processed + 1}/${videos.length}…`;
          try {
            await exportMediaCard(card, quality, matchIndex, video?.title || "");
            state.success += 1;
            state.message = `${quality}: video ${state.processed + 1}/${videos.length} completed`;
            log(`[#${state.processed + 1}/${videos.length}] Completed "${videoTitle}"`);
          } catch (error) {
            state.failed += 1;
            recordFailure(video, state.processed + 1, error);
            state.message = `${quality}: ${error.message}`;
          } finally {
            state.processed += 1;
            updateTimingStats(videos.length);
            await closeActiveMenus();
            await sleep(800);
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

      updateTimingStats(videos.length);
      if (state.stopRequested) {
        state.message = `Stopped — ${state.success} downloaded, ${state.failed} failed`;
      } else {
        state.message = `Finished — ${state.success} downloaded, ${state.failed} failed`;
        if (options.soundNotifications !== false) {
          playCompletionChime(state.failed === 0);
          void notifyCompletion(
            "Flow Export Complete",
            `${state.success} downloaded, ${state.failed} failed.`,
          );
        }
      }
      log(state.message);
    } catch (error) {
      state.failed += 1;
      state.lastError = error.message;
      state.message = error.message;
      log(`Batch error: ${error.message}`);
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
      if (!state.running) {
        void runBatch(message.quality, null, {
          organizeSubfolders: message.organizeSubfolders !== false,
          soundNotifications: message.soundNotifications !== false,
          customFolder: message.customFolder || "",
          selectedMediaIds: Array.isArray(message.selectedMediaIds) ? message.selectedMediaIds : null,
        });
      }
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
      void runBatch(quality, uniqueFailures, {
        organizeSubfolders: message.organizeSubfolders !== false,
        soundNotifications: message.soundNotifications !== false,
        customFolder: message.customFolder || "",
      });
      sendResponse({ ok: true, retryCount: uniqueFailures.length });
      return false;
    }

    if (message?.type === "FLOW_GET_SELECTION") {
      sendResponse({
        ok: true,
        selectedCount: selectedMediaIds.size,
        selectedMediaIds: [...selectedMediaIds],
      });
      return false;
    }

    if (message?.type === "FLOW_CLEAR_SELECTION") {
      selectedMediaIds.clear();
      lastSelectedMediaId = null;
      tileSelectionAnchors = new WeakMap();
      updateAllDecoratedButtons();
      updateFloatingDock();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "FLOW_STOP_BATCH") {
      log("Export stop requested.");
      state.stopRequested = true;
      state.message = "Stopping after the current video…";
      if (pendingDownload) pendingDownload.resolve({ kind: "cancelled" });
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }

    if (message?.type === "FLOW_DOWNLOAD_DETECTED" && pendingDownload?.token === message.token) {
      log(`Chrome reported download complete: ${message.filename || message.downloadId}`);
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
      log(`Chrome reported download failure: ${message.error || "unknown"}`);
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

  if (typeof setInterval !== "undefined") {
    if (usesModernFlow()) scheduleGridDecoration();
    setInterval(() => {
      if (usesModernFlow()) {
        scheduleGridDecoration();
      }
    }, 800);
  }
})();
