import json

with open("original_html.json", "r") as f:
    for line in f:
        data = json.loads(line.strip())
        if "tool_responses" in data:
            for resp in data["tool_responses"]:
                if "popup.js" in resp.get("args", {}).get("AbsolutePath", "") or "popup.js" in resp["output"]:
                    # Wait, popup.js wasn't viewed in step 3!
                    # Only popup.html and popup.css were viewed!
                    pass
