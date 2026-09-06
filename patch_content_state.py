import re

with open("content.js", "r") as f:
    content = f.read()

state_addition = """    stopRequested: false,
    paused: false,
    pauseRequested: false,
    videos: [],
    pattern: "",
    selectedIndices: null,"""

content = content.replace("    stopRequested: false,", state_addition)

reset_state = """  function resetState(mode, quality = null) {
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
  }"""
content = re.sub(r'  function resetState\(mode, quality = null\) \{[\s\S]*?  \}', reset_state, content)


scan_project = """  async function scanProject() {
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
    } catch (error) {"""
content = content.replace("  async function scanProject() {\n    if (state.running) return;\n    resetState(\"Scan\");\n    try {\n      const videos = await resolveVideoInventory(true);\n      state.found = videos.length;\n      state.processed = videos.length;\n      state.message = state.stopRequested\n        ? `Scan stopped after ${state.found} videos`\n        : `Found ${state.found} videos`;\n    } catch (error) {", scan_project)

with open("content.js", "w") as f:
    f.write(content)
