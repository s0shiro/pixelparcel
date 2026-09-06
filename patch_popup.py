import re

with open("popup.js", "r") as f:
    content = f.read()

controls_addition = """  filenamePattern: document.querySelector("#filename-pattern"),
  selectionCard: document.querySelector("#selection-card"),
  selectAll: document.querySelector("#select-all"),
  videoList: document.querySelector("#video-list"),
  pause: document.querySelector("#pause-button"),
  resume: document.querySelector("#resume-button"),"""

content = content.replace("  stop: document.querySelector(\"#stop-button\"),", f"  stop: document.querySelector(\"#stop-button\"),\n{controls_addition}")

render_additions = """
  controls.pause.hidden = !running || state?.paused;
  controls.resume.hidden = !running || !state?.paused;
  controls.pause.disabled = !running;
  controls.resume.disabled = !running;

  // Handle video list rendering if videos are available
  const videos = Array.isArray(state?.videos) ? state.videos : [];
  if (videos.length > 0 && !running && state?.mode === "Idle" && controls.videoList.children.length === 0) {
    controls.selectionCard.hidden = false;
    controls.videoList.replaceChildren(...videos.map((vid, idx) => {
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = vid.index; // Or vid.id
      cb.checked = controls.selectAll.checked;
      cb.className = "video-checkbox";
      lbl.append(cb, ` #${vid.index} - ${vid.title}`);
      return lbl;
    }));
  } else if (running || videos.length === 0) {
    // maybe keep it visible but disabled, or just hide? Let's hide if no videos.
    if (videos.length === 0) {
        controls.selectionCard.hidden = true;
        controls.videoList.innerHTML = "";
    }
  }
"""

content = content.replace("  controls.stop.disabled = !running || !flowTab;", f"  controls.stop.disabled = !running || !flowTab;\n{render_additions}")

issue_modification = """async function issue(message) {
  if (message.type === "FLOW_START_BATCH" || message.type === "FLOW_RETRY_FAILURES") {
    message.pattern = controls.filenamePattern.value.trim();
    
    // Get selected indices
    const checkboxes = Array.from(controls.videoList.querySelectorAll(".video-checkbox"));
    if (checkboxes.length > 0) {
        message.selectedIndices = checkboxes.filter(cb => cb.checked).map(cb => parseInt(cb.value, 10));
    }
  }
"""

content = content.replace("async function issue(message) {", issue_modification)

events_addition = """
controls.selectAll.addEventListener("change", (e) => {
  const checkboxes = controls.videoList.querySelectorAll(".video-checkbox");
  checkboxes.forEach(cb => cb.checked = e.target.checked);
});

controls.pause.addEventListener("click", () => issue({ type: "FLOW_PAUSE_BATCH" }));
controls.resume.addEventListener("click", () => issue({ type: "FLOW_RESUME_BATCH" }));
"""

content = content.replace('controls.stop.addEventListener("click", () => issue({ type: "FLOW_STOP_BATCH" }));', f'controls.stop.addEventListener("click", () => issue({{ type: "FLOW_STOP_BATCH" }}));\n{events_addition}')


with open("popup.js", "w") as f:
    f.write(content)
