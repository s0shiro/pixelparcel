with open("background.js", "r") as f:
    content = f.read()
if "FLOW_FETCH_INVENTORY" not in content:
    content += """
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FLOW_FETCH_INVENTORY") {
    const input = encodeURIComponent(JSON.stringify({ json: { projectId: message.projectId } }));
    fetch(`https://labs.google/fx/api/trpc/flow.projectInitialData?input=${input}`, {
      credentials: "include",
      cache: "no-store",
    })
    .then(res => res.json())
    .then(data => sendResponse({ ok: true, payload: data }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // Keep message channel open for async response
  }
  if (message?.type === "FLOW_SHOW_NOTIFICATION") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: message.title,
      message: message.body,
      priority: 2
    });
    sendResponse({ ok: true });
    return false;
  }
});
"""
with open("background.js", "w") as f:
    f.write(content)
