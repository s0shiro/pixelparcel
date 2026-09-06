with open("background.js", "r") as f:
    lines = f.readlines()

new_lines = lines[:124]
new_lines.append("""  }

  return false;
});

chrome.downloads.onCreated.addListener((item) => {
  expireOldWatches();
  if (!activeWatches.size) return;
  if (activeWatches.size > 1 && !looksLikeVideoDownload(item)) return;

  for (const [tabId, watch] of activeWatches) {
    activeWatches.delete(tabId);
    chrome.tabs.sendMessage(tabId, {
      type: "FLOW_DOWNLOAD_DETECTED",
      token: watch.token,
      downloadId: item.id,
      filename: item.filename || "",
    }).catch(() => undefined);
    break;
  }
});
""")

with open("background.js", "w") as f:
    f.write("".join(new_lines))
