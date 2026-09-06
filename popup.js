"use strict";

const controls = {
  pageStatus: document.querySelector("#page-status"),
  jobMessage: document.querySelector("#job-message"),
  jobMode: document.querySelector("#job-mode"),
  progressBar: document.querySelector("#progress-bar"),
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
};

let flowTab = null;
let refreshing = false;

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

function render(state) {
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
  controls.lastError.textContent = state?.lastError ? `Last error: ${state.lastError}` : "";
  controls.lastError.hidden = !state?.lastError;
  const failures = Array.isArray(state?.failures) ? state.failures : [];
  controls.failureList.replaceChildren(...failures.map((failure) => {
    const item = document.createElement("div");
    item.className = "failure-item";
    const title = document.createElement("div");
    title.className = "failure-title";
    title.textContent = `#${failure.index} — ${failure.title}`;
    const reason = document.createElement("div");
    reason.className = "failure-reason";
    reason.textContent = failure.error;
    item.append(title, reason);
    return item;
  }));
  controls.failureReport.hidden = failures.length === 0;

  controls.scan.disabled = running || !flowTab;
  controls.download720.disabled = running || !flowTab;
  controls.download1080.disabled = running || !flowTab;
  controls.retry.disabled = running || !flowTab || failures.length === 0;
  controls.retry.textContent = failures.length === 1
    ? "Retry 1 failed video"
    : `Retry ${failures.length} failed videos`;
  controls.stop.disabled = !running || !flowTab;
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

controls.scan.addEventListener("click", () => issue({ type: "FLOW_SCAN_PROJECT" }));
controls.download720.addEventListener("click", () => issue({ type: "FLOW_START_BATCH", quality: "720p" }));
controls.download1080.addEventListener("click", () => issue({ type: "FLOW_START_BATCH", quality: "1080p" }));
controls.retry.addEventListener("click", () => issue({ type: "FLOW_RETRY_FAILURES" }));
controls.stop.addEventListener("click", () => issue({ type: "FLOW_STOP_BATCH" }));

(async function initialize() {
  render(null);
  await refresh();
  setInterval(refresh, 600);
})();
