import re

with open("background.js", "r") as f:
    content = f.read()

msg_notify = """  if (message?.type === "FLOW_SHOW_NOTIFICATION") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: message.title || "Flow Bulk Exporter",
      message: message.body || "Task completed."
    });
    sendResponse({ ok: true });
    return false;
  }"""
content = content.replace("  return false;\n});", msg_notify + "\n\n  return false;\n});")

with open("background.js", "w") as f:
    f.write(content)

with open("content.js", "r") as f:
    c_content = f.read()

notify_patch = """      if (state.stopRequested) {
        state.message = `Stopped — ${state.success} downloaded, ${state.failed} failed`;
      } else {
        state.message = `Finished — ${state.success} downloaded, ${state.failed} failed`;
        try {
          chrome.runtime.sendMessage({
            type: "FLOW_SHOW_NOTIFICATION",
            title: "Batch Export Complete",
            body: `${state.success} downloaded, ${state.failed} failed.`
          });
        } catch (e) {}
      }"""
c_content = c_content.replace("""      if (state.stopRequested) {
        state.message = `Stopped — ${state.success} downloaded, ${state.failed} failed`;
      } else {
        state.message = `Finished — ${state.success} downloaded, ${state.failed} failed`;
      }""", notify_patch)

with open("content.js", "w") as f:
    f.write(c_content)
