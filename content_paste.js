  async function resolveVideoInventory(force = false) {
    try {
      const inventory = await fetchProjectInventory(force);
      if (Array.isArray(inventory)) return inventory;
      throw new Error("This page URL does not expose a Flow project ID.");
    } catch (error) {
      state.lastError = error.message;
      state.message = "Project inventory unavailable; scanning the full media grid…";
      return fallbackVideoInventory();
    }
  }

  function resetState(mode, quality = null) {
    state.running = true;
    state.mode = mode;
    state.quality = quality;
    state.stopRequested = false;
    state.paused = false;
    state.pauseRequested = false;
    state.found = 0;
    state.processed = 0;
    state.success = 0;
    state.failed = 0;
    state.skipped = 0;
    state.failures = [];
    state.message = "Initializing…";
    state.lastError = "";
  }

  async function scanProject() {
    if (state.running) return;
    resetState("Scan");
    try {
      const videos = await resolveVideoInventory(true);
      state.found = videos.length;
      state.processed = videos.length;
      state.videos = videos.map((v, i) => ({ index: i + 1, title: v.title, id: v.mediaId }));
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
