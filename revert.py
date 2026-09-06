import re

with open("content.js", "r") as f:
    c = f.read()

# 1. Revert state additions
c = re.sub(r'    stopRequested: false,\n    paused: false,\n    pauseRequested: false,\n    videos: \[\],\n    pattern: "",\n    selectedIndices: null,', '    stopRequested: false,', c)

# 2. Revert resetState
reset_orig = """  function resetState(mode, quality = null) {
    state.running = true;
    state.mode = mode;
    state.quality = quality;
    state.stopRequested = false;
    state.found = 0;
    state.processed = 0;
    state.success = 0;
    state.failed = 0;
    state.skipped = 0;
    state.failures = [];
    state.message = "Initializing…";
    state.lastError = "";
  }"""
c = re.sub(r'  function resetState\(mode, quality = null\) \{[\s\S]*?  \}', reset_orig, c)

# 3. Revert scanProject
scan_orig = """  async function scanProject() {
    if (state.running) return;
    resetState("Scan");
    try {
      const videos = await resolveVideoInventory(true);
      state.found = videos.length;
      state.processed = videos.length;
      state.message = state.stopRequested
        ? `Scan stopped after ${state.found} videos`
        : `Found ${state.found} videos`;
    } catch (error) {"""
c = re.sub(r'  async function scanProject\(\) \{[\s\S]*?    \} catch \(error\) \{', scan_orig, c)

# 4. Revert resolveVideoInventory
resolve_orig = """  async function resolveVideoInventory(force = false) {
    try {
      const inventory = await fetchProjectInventory(force);
      if (Array.isArray(inventory)) return inventory;
      throw new Error("This page URL does not expose a Flow project ID.");
    } catch (error) {
      state.lastError = error.message;
      state.message = "Project inventory unavailable; scanning the full media grid…";
      return fallbackVideoInventory();
    }
  }"""
c = re.sub(r'  async function resolveVideoInventory\(force = false\) \{[\s\S]*?    \}\n  \}', resolve_orig, c)

# 5. Revert fetchProjectInventory fetch
fetch_orig = """    const input = encodeURIComponent(JSON.stringify({ json: { projectId } }));
    const response = await fetch(`https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Flow project inventory returned HTTP ${response.status}.`);
    const payload = await response.json();"""
c = re.sub(r'    const input = encodeURIComponent\(JSON\.stringify\(\{ json: \{ projectId \} \}\)\);\n    const response = await chrome\.runtime\.sendMessage\(\{[\s\S]*?    const payload = response\.payload;', fetch_orig, c)

# 6. Revert mediaLabel
label_orig = """  function mediaLabel(element, index, quality, preferredTitle = "") {
    let current = element;
    let label = "";
    for (let depth = 0; current && depth < 6 && !preferredTitle; depth += 1, current = current.parentElement) {
      label ||= current.getAttribute?.("aria-label") || current.getAttribute?.("title") || "";
    }
    const finalTitle = preferredTitle || label;
    const stem = Core.safeFilename(finalTitle, `flow-video-${String(index).padStart(3, "0")}`);
    return `${stem}-${quality}.mp4`;
  }"""
c = re.sub(r'  function mediaLabel\(element, index, quality, preferredTitle = "", mediaId = ""\) \{[\s\S]*?    return `\$\{stem\}-\$\{quality\}\.mp4`;\n  \}', label_orig, c)

# 7. Revert runBatch (720p loop and pause check)
runbatch_orig = """      state.found = videos.length;

      if (quality === "720p") {
        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {
          const video = videos[index];
          state.message = `720p: downloading video ${index + 1}/${videos.length}…`;
          try {
            await directDownloadMediaId(
              video.mediaId,
              mediaLabel(null, index + 1, quality, video.title),
            );"""
c = re.sub(r'      if \(\!requestedFailures\?\.length && state\.selectedIndices\) \{[\s\S]*?              mediaLabel\(null, index \+ 1, quality, video\.title, video\.mediaId\),\n            \);', runbatch_orig, c)

# 8. Revert 1080p walkMediaGrid loop inside runBatch
walk_orig = """        const walkResult = await walkMediaGrid(targetById, async (card, matchIndex, video) => {
          if (state.stopRequested) return;
          state.message = `1080p: processing video ${state.processed + 1}/${videos.length}…`;
          try {
            await exportMediaCard(card, quality, matchIndex, video?.title || "");"""
c = re.sub(r'        const walkResult = await walkMediaGrid\(targetById, async \(card, matchIndex, video\) => \{[\s\S]*?            await exportMediaCard\(card, quality, matchIndex, video\?\.title \|\| "", video\?\.mediaId \|\| ""\);', walk_orig, c)

# 9. Remove notification from runBatch
notif = """        try {
          chrome.runtime.sendMessage({
            type: "FLOW_SHOW_NOTIFICATION",
            title: "Batch Export Complete",
            body: `${state.success} downloaded, ${state.failed} failed.`
          });
        } catch (e) {}"""
c = c.replace(notif, "")

# 10. Revert FLOW_START_BATCH messages
msg_start_orig = """    if (message?.type === "FLOW_START_BATCH") {
      if (!["720p", "1080p"].includes(message.quality)) {
        sendResponse({ ok: false, error: "Unsupported export quality." });
        return false;
      }
      if (!state.running) {
        void runBatch(message.quality);
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
      void runBatch(quality, uniqueFailures);
      sendResponse({ ok: true, retryCount: uniqueFailures.length });
      return false;
    }"""
c = re.sub(r'    if \(message\?\.type === "FLOW_START_BATCH"\) \{[\s\S]*?    if \(message\?\.type === "FLOW_PAUSE_BATCH"\) \{', msg_start_orig + '\n\n    if (message?.type === "FLOW_PAUSE_BATCH") {', c)

# 11. Remove FLOW_PAUSE_BATCH and FLOW_RESUME_BATCH
c = re.sub(r'    if \(message\?\.type === "FLOW_PAUSE_BATCH"\) \{[\s\S]*?    if \(message\?\.type === "FLOW_STOP_BATCH"\) \{', '    if (message?.type === "FLOW_STOP_BATCH") {', c)

with open("content.js", "w") as f:
    f.write(c)

# Now revert background.js
with open("background.js", "r") as f:
    bg = f.read()

bg = re.sub(r'  if \(message\?\.type === "FLOW_SHOW_NOTIFICATION"\) \{[\s\S]*?  \}', '', bg)
bg = re.sub(r'  if \(message\?\.type === "FLOW_FETCH_INVENTORY"\) \{[\s\S]*?  \}', '', bg)
with open("background.js", "w") as f:
    f.write(bg)

