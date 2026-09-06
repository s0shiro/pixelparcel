import re

with open("content.js", "r") as f:
    content = f.read()

msg_start = """    if (message?.type === "FLOW_START_BATCH") {
      if (!["720p", "1080p"].includes(message.quality)) {
        sendResponse({ ok: false, error: "Unsupported export quality." });
        return false;
      }
      if (!state.running) {
        state.pattern = message.pattern || "";
        state.selectedIndices = message.selectedIndices || null;
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
      state.pattern = message.pattern || "";
      state.selectedIndices = message.selectedIndices || null;
      void runBatch(quality, uniqueFailures);
      sendResponse({ ok: true, retryCount: uniqueFailures.length });
      return false;
    }"""
content = re.sub(r'    if \(message\?\.type === "FLOW_START_BATCH"\) \{[\s\S]*?      return false;\n    \}', msg_start, content)


msg_pause = """    if (message?.type === "FLOW_PAUSE_BATCH") {
      state.pauseRequested = true;
      state.message = "Pausing after current video...";
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }

    if (message?.type === "FLOW_RESUME_BATCH") {
      state.pauseRequested = false;
      state.paused = false;
      state.message = `Processing video ${state.processed} of ${state.found}`;
      sendResponse({ ok: true, state: snapshotState() });
      return false;
    }"""
content = content.replace("    if (message?.type === \"FLOW_STOP_BATCH\") {", msg_pause + "\n\n    if (message?.type === \"FLOW_STOP_BATCH\") {")

with open("content.js", "w") as f:
    f.write(content)
