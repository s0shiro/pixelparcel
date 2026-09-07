"use strict";

const controls = {
  pageStatus: document.querySelector("#page-status"),
  jobMessage: document.querySelector("#job-message"),
  jobMode: document.querySelector("#job-mode"),
  progressBar: document.querySelector("#progress-bar"),
  timingRow: document.querySelector("#timing-row"),
  elapsedTime: document.querySelector("#elapsed-time"),
  speedStat: document.querySelector("#speed-stat"),
  etaTime: document.querySelector("#eta-time"),
  found: document.querySelector("#found-count"),
  success: document.querySelector("#success-count"),
  failed: document.querySelector("#failed-count"),
  lastError: document.querySelector("#last-error"),
  failureReport: document.querySelector("#failure-report"),
  failureList: document.querySelector("#failure-list"),
  scan: document.querySelector("#scan-button"),
  download720: document.querySelector("#download-720-button"),
  download1080: document.querySelector("#download-1080-button"),
  retry: document.querySelector("#retry-button"),
  stop: document.querySelector("#stop-button"),
  copyLogs: document.querySelector("#copy-logs-button"),
  optSubfolders: document.querySelector("#opt-subfolders"),
  optNotifications: document.querySelector("#opt-notifications"),
  customFolderInput: document.querySelector("#custom-folder-input"),
  customFolderReset: document.querySelector("#custom-folder-reset"),
  folderPreview: document.querySelector("#folder-preview"),
  selectionNotice: document.querySelector("#selection-notice"),
  selectionText: document.querySelector("#selection-text"),
  selectionClearBtn: document.querySelector("#selection-clear-btn"),
};

let flowTab = null;
let refreshing = false;
let lastState = null;
let inPageSelection = [];

async function getFlowTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return null;
  const url = tab.pendingUrl || tab.url;
  if (!url) {
    throw new Error("Chrome cannot read this tab's address. Reload the extension, allow access to the Flow site, then click its icon on the Flow tab.");
  }
  return globalThis.FlowBulkCore.isFlowPage(url) ? tab : null;
}

async function send(message) {
  if (!Number.isInteger(flowTab?.id) || flowTab.id < 0) throw new Error("Select your Google Flow project tab first.");
  return chrome.tabs.sendMessage(flowTab.id, message);
}

function updateSelectionUI() {
  const count = inPageSelection.length;
  if (controls.selectionNotice) {
    controls.selectionNotice.hidden = count === 0;
    if (controls.selectionText) {
      controls.selectionText.textContent = `${count} video${count === 1 ? "" : "s"} selected in grid`;
    }
  }
  if (count > 0) {
    if (controls.download720) controls.download720.textContent = `Download ${count} selected 720p`;
    if (controls.download1080) controls.download1080.textContent = `Upscale + download ${count} selected 1080p`;
  } else {
    if (controls.download720) controls.download720.textContent = "Download all 720p";
    if (controls.download1080) controls.download1080.textContent = "Upscale + download all 1080p";
  }
}

function render(state) {
  lastState = state;
  const running = Boolean(state?.running);
  const found = Number(state?.found || 0);
  const processed = Number(state?.processed || 0);
  const success = Number(state?.success || 0);
  const failed = Number(state?.failed || 0);
  const denominator = Math.max(found, processed, 1);
  const progress = running ? Math.min(98, (processed / denominator) * 100) : (processed ? 100 : 0);

  controls.jobMessage.textContent = state?.message || "Ready";
  controls.jobMode.textContent = state?.mode || "Idle";
  controls.progressBar.style.width = `${progress}%`;
  controls.found.textContent = found;
  controls.success.textContent = success;
  controls.failed.textContent = failed;

  if (controls.elapsedTime) controls.elapsedTime.textContent = state?.elapsed || "00:00";
  if (controls.speedStat) controls.speedStat.textContent = state?.speed || "--";
  if (controls.etaTime) controls.etaTime.textContent = state?.eta || "--:--";
  if (controls.timingRow) controls.timingRow.hidden = !running && (!state?.elapsed || state.elapsed === "00:00");

  controls.lastError.textContent = state?.lastError ? `Last error: ${state.lastError}` : "";
  controls.lastError.hidden = !state?.lastError;

  const failures = Array.isArray(state?.failures) ? state.failures : [];
  controls.failureList.replaceChildren(...failures.map((failure) => {
    const item = document.createElement("div");
    item.className = "failure-item";

    const title = document.createElement("div");
    title.className = "failure-title";
    title.textContent = `#${failure.index || "?"} — ${failure.title || failure.mediaId || "Unknown video"}`;

    const reason = document.createElement("div");
    reason.className = "failure-reason";
    reason.textContent = failure.error || "Unknown failure";

    item.append(title, reason);
    return item;
  }));
  controls.failureReport.hidden = failures.length === 0;

  controls.scan.disabled = running || !flowTab;
  controls.download720.disabled = running || !flowTab;
  controls.download1080.disabled = running || !flowTab;
  controls.retry.disabled = running || failures.length === 0 || !flowTab;
  controls.retry.textContent = failures.length <= 1
    ? "Retry 1 failed video"
    : `Retry ${failures.length} failed videos`;
  controls.stop.disabled = !running || !flowTab;

  updateSelectionUI();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    flowTab = await getFlowTab();
    if (!flowTab) {
      throw new Error("Select your Google Flow project tab, then click this extension's icon.");
    }
    let state;
    try {
      state = await send({ type: "FLOW_GET_STATUS" });
      if (!state || typeof state.running !== "boolean") throw new Error("No Flow status received.");
    } catch {
      throw new Error("Flow detected, but the extension is not connected. Allow site access and reload the Flow tab, then reopen this extension.");
    }
    controls.pageStatus.textContent = "Current Flow project detected";
    controls.pageStatus.classList.remove("error");

    if (flowTab?.id) {
      void send({ type: "FLOW_GET_SELECTION" }).then((res) => {
        if (res?.ok && Array.isArray(res.selectedMediaIds)) {
          inPageSelection = res.selectedMediaIds;
          updateSelectionUI();
        }
      }).catch(() => undefined);
    }

    render(state);
  } catch (error) {
    flowTab = null;
    controls.pageStatus.textContent = error.message;
    controls.pageStatus.classList.add("error");
    render(null);
  } finally {
    refreshing = false;
  }
}

async function issue(message) {
  try {
    await send(message);
    await refresh();
  } catch (error) {
    controls.pageStatus.textContent = error.message;
    controls.pageStatus.classList.add("error");
  }
}

function getBatchOptions() {
  return {
    organizeSubfolders: controls.optSubfolders?.checked !== false,
    soundNotifications: controls.optNotifications?.checked !== false,
    customFolder: controls.customFolderInput?.value?.trim() || "",
    selectedMediaIds: inPageSelection.length > 0 ? inPageSelection : null,
  };
}

controls.scan.addEventListener("click", () => issue({ type: "FLOW_SCAN_PROJECT" }));

controls.download720.addEventListener("click", () => {
  issue({ type: "FLOW_START_BATCH", quality: "720p", ...getBatchOptions() });
});

controls.download1080.addEventListener("click", () => {
  issue({ type: "FLOW_START_BATCH", quality: "1080p", ...getBatchOptions() });
});

controls.retry.addEventListener("click", () => {
  issue({ type: "FLOW_RETRY_FAILURES", ...getBatchOptions() });
});

controls.stop.addEventListener("click", () => issue({ type: "FLOW_STOP_BATCH" }));

controls.selectionClearBtn?.addEventListener?.("click", () => {
  inPageSelection = [];
  updateSelectionUI();
  void send({ type: "FLOW_CLEAR_SELECTION" }).catch(() => undefined);
});

function saveOptions() {
  if (chrome.storage?.local?.set) {
    chrome.storage.local.set({
      organizeSubfolders: controls.optSubfolders?.checked !== false,
      soundNotifications: controls.optNotifications?.checked !== false,
      customFolder: controls.customFolderInput?.value?.trim() || "",
    }).catch(() => undefined);
  }
}

function updateFolderUI() {
  const useFolder = controls.optSubfolders?.checked !== false;
  const folder = globalThis.FlowBulkCore.sanitizeFolderPath(
    controls.customFolderInput?.value?.trim() || "Flow Videos",
    "Flow Videos",
  );
  if (controls.customFolderInput) controls.customFolderInput.disabled = !useFolder;
  if (controls.customFolderReset) controls.customFolderReset.disabled = !useFolder;
  if (controls.folderPreview) {
    controls.folderPreview.textContent = useFolder
      ? `Location: Downloads/${folder}/`
      : "Location: Downloads/ (no export folder)";
  }
}

async function loadOptions() {
  if (chrome.storage?.local?.get) {
    try {
      const saved = await chrome.storage.local.get(["organizeSubfolders", "soundNotifications", "customFolder"]);
      if (typeof saved?.organizeSubfolders === "boolean" && controls.optSubfolders) {
        controls.optSubfolders.checked = saved.organizeSubfolders;
      }
      if (typeof saved?.soundNotifications === "boolean" && controls.optNotifications) {
        controls.optNotifications.checked = saved.soundNotifications;
      }
      if (typeof saved?.customFolder === "string" && controls.customFolderInput) {
        controls.customFolderInput.value = saved.customFolder;
      }
    } catch {}
  }
  updateFolderUI();
}

controls.optSubfolders?.addEventListener?.("change", () => {
  updateFolderUI();
  saveOptions();
});
controls.optNotifications?.addEventListener?.("change", saveOptions);
controls.customFolderInput?.addEventListener?.("input", () => {
  updateFolderUI();
  saveOptions();
});
controls.customFolderReset?.addEventListener?.("click", () => {
  if (controls.customFolderInput) {
    controls.customFolderInput.value = "";
    updateFolderUI();
    saveOptions();
  }
});

function formatLogs(state) {
  const timestamp = new Date().toISOString();
  const localTime = new Date().toLocaleString();
  const lines = [
    "=== FLOW BULK VIDEO EXPORTER LOGS ===",
    `Generated at: ${timestamp} (${localTime})`,
  ];

  if (!state) {
    lines.push("Status: Not connected to a Flow project tab.");
    return lines.join("\n");
  }

  lines.push(`Mode: ${state.mode || "Idle"}`);
  lines.push(`Message: ${state.message || "Ready"}`);
  lines.push(`Quality: ${state.quality || state.lastQuality || "N/A"}`);
  lines.push(`Stats: ${state.found || 0} found | ${state.success || 0} downloaded | ${state.failed || 0} failed`);
  if (state.elapsed || state.eta) {
    lines.push(`Timing: Elapsed: ${state.elapsed || "00:00"} | Speed: ${state.speed || "--"} | ETA: ${state.eta || "--:--"}`);
  }

  if (state.lastError) {
    lines.push(`Last error: ${state.lastError}`);
  }

  const failures = Array.isArray(state.failures) ? state.failures : [];
  if (failures.length > 0) {
    lines.push("");
    lines.push(`--- FAILED VIDEOS (${failures.length}) ---`);
    for (const failure of failures) {
      lines.push(`#${failure.index} — ${failure.title || failure.mediaId || "Unknown"}: ${failure.error}`);
    }
  }

  const logs = Array.isArray(state.logs) ? state.logs : [];
  lines.push("");
  lines.push(`--- ACTIVITY LOGS (${logs.length} entries) ---`);
  if (logs.length > 0) {
    lines.push(...logs);
  } else {
    lines.push("(No activity logs recorded yet. Start a scan or download to generate logs.)");
  }

  return lines.join("\n");
}

async function copyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to DOM fallback
    }
  }
  if (typeof document !== "undefined" && document.body?.appendChild) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      return true;
    } catch {
      // Failed
    }
  }
  return false;
}

controls.copyLogs?.addEventListener("click", async () => {
  let state = lastState;
  try {
    if (flowTab?.id) {
      const live = await send({ type: "FLOW_GET_STATUS" });
      if (live && typeof live.running === "boolean") state = live;
    }
  } catch {
    // Retain lastState if live fetch fails
  }

  const text = formatLogs(state);
  await copyToClipboard(text);
  const btn = controls.copyLogs;
  if (!btn) return;
  const originalText = btn.textContent;
  btn.textContent = "✓ Logs copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = originalText;
    btn.classList.remove("copied");
  }, 2500);
});

(async function initialize() {
  await loadOptions();
  render(null);
  await refresh();
  setInterval(refresh, 600);
})();
