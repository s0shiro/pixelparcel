import re

with open("content.js", "r") as f:
    content = f.read()

label_func = """  function mediaLabel(element, index, quality, preferredTitle = "", mediaId = "") {
    let current = element;
    let label = "";
    for (let depth = 0; current && depth < 6 && !preferredTitle; depth += 1, current = current.parentElement) {
      label ||= current.getAttribute?.("aria-label") || current.getAttribute?.("title") || "";
    }
    const finalTitle = preferredTitle || label;
    
    if (state.pattern) {
        let custom = state.pattern;
        custom = custom.replace(/{index}/g, String(index).padStart(3, "0"));
        custom = custom.replace(/{title}/g, Core.safeFilename(finalTitle, "video"));
        custom = custom.replace(/{id}/g, mediaId || "unknown");
        return custom.endsWith(".mp4") ? custom : `${custom}.mp4`;
    }
    
    const stem = Core.safeFilename(finalTitle, `flow-video-${String(index).padStart(3, "0")}`);
    return `${stem}-${quality}.mp4`;
  }"""
content = re.sub(r'  function mediaLabel\(element, index, quality, preferredTitle = ""\) \{[\s\S]*?    return `\$\{stem\}-\$\{quality\}\.mp4`;\n  \}', label_func, content)


# Patch runBatch for filter and pause

batch_patch = """      if (!requestedFailures?.length && state.selectedIndices) {
        videos = videos.filter((v, i) => state.selectedIndices.includes(i + 1));
      }
      state.found = videos.length;

      async function checkPause() {
        if (state.pauseRequested) {
          state.paused = true;
          state.message = "Paused";
        }
        while (state.paused && !state.stopRequested) {
          await sleep(500);
        }
      }

      if (quality === "720p") {
        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {
          await checkPause();
          if (state.stopRequested) break;
          const video = videos[index];
          state.message = `720p: downloading video ${index + 1}/${videos.length}…`;
          try {
            await directDownloadMediaId(
              video.mediaId,
              mediaLabel(null, index + 1, quality, video.title, video.mediaId),
            );"""
content = content.replace("      state.found = videos.length;\n\n      if (quality === \"720p\") {\n        for (let index = 0; index < videos.length && !state.stopRequested; index += 1) {\n          const video = videos[index];\n          state.message = `720p: downloading video ${index + 1}/${videos.length}…`;\n          try {\n            await directDownloadMediaId(\n              video.mediaId,\n              mediaLabel(null, index + 1, quality, video.title),\n            );", batch_patch)

walk_patch = """        const walkResult = await walkMediaGrid(targetById, async (card, matchIndex, video) => {
          await checkPause();
          if (state.stopRequested) return;
          state.message = `1080p: processing video ${state.processed + 1}/${videos.length}…`;
          try {
            await exportMediaCard(card, quality, matchIndex, video?.title || "", video?.mediaId || "");"""
content = content.replace("""        const walkResult = await walkMediaGrid(targetById, async (card, matchIndex, video) => {
          state.message = `1080p: processing video ${state.processed + 1}/${videos.length}…`;
          try {
            await exportMediaCard(card, quality, matchIndex, video?.title || "");""", walk_patch)

export_patch = """  async function exportMediaCard(card, quality, index, title = "", mediaId = "") {
    if (!isVisible(card)) {
      setScrollTop(findScrollableAncestor(card), card.offsetTop - 120);
      await sleep(100);
    }

    const { resolutionWidth, resolutionHeight } = resolutionCandidates()[quality];
    const originalHeight = Number(card.style.height?.replace("px", "") || 0);

    const assetMenu = await openAssetMenu(card);
    if (!assetMenu) throw new Error("Could not open Flow asset menu.");

    const choice = findResolutionChoice(quality, originalHeight);
    if (!choice) throw new Error(`Resolution ${quality} was not available.`);

    dispatchPointerEvent(choice, "pointerdown");
    dispatchPointerEvent(choice, "pointerup");
    choice.click();

    const flowConfirmed = await confirmFlowDialog();
    if (!flowConfirmed) throw new Error("Could not confirm Flow asset export.");

    const downloadToken = Math.random().toString(36).slice(2);
    pendingDownload = { token: downloadToken, resolve: null };
    const downloadPromise = new Promise((resolve) => { pendingDownload.resolve = resolve; });

    beginDownloadWatch(downloadToken, 240000); // 4 minute wait for 1080p upscale
    const result = await downloadPromise;

    if (result.kind === "cancelled") {
      throw new Error("Batch stopped by user.");
    }
    if (result.kind === "timeout") {
      throw new Error("Timed out waiting for upscale download.");
    }

    const filename = mediaLabel(card, index, quality, title, mediaId);"""
content = re.sub(r'  async function exportMediaCard\(card, quality, index, title = ""\) \{[\s\S]*?    const filename = mediaLabel\(card, index, quality, title\);', export_patch, content)

with open("content.js", "w") as f:
    f.write(content)
