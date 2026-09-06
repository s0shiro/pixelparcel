import json

with open("original_html.json", "r") as f:
    for line in f:
        data = json.loads(line.strip())
        if "tool_responses" in data:
            for resp in data["tool_responses"]:
                if "popup.html" in resp["output"]:
                    lines = resp["output"].split("\n")
                    start_idx = 0
                    for i, l in enumerate(lines):
                        if l.startswith("1: "):
                            start_idx = i
                            break
                    html_lines = []
                    for l in lines[start_idx:]:
                        if l.startswith("The above content shows the entire"):
                            break
                        parts = l.split(": ", 1)
                        if len(parts) > 1:
                            html_lines.append(parts[1])
                        else:
                            html_lines.append("")
                    with open("popup.html", "w") as out:
                        out.write("\n".join(html_lines))
                    break
