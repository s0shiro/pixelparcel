with open("content.js", "r") as f:
    c = f.read()
if "FLOW_SHOW_NOTIFICATION" not in c:
    notif = """        try {
          chrome.runtime.sendMessage({
            type: "FLOW_SHOW_NOTIFICATION",
            title: "Batch Export Complete",
            body: `${state.success} downloaded, ${state.failed} failed.`
          });
        } catch (e) {}"""
    c = c.replace('state.mode = "Idle";\n    }', 'state.mode = "Idle";\n' + notif + '\n    }')
    with open("content.js", "w") as f:
        f.write(c)
