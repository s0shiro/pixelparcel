import re

with open("popup.js", "r") as f:
    content = f.read()

content = content.replace("    if (videos.length === 0) {\n        controls.selectionCard.hidden = true;\n        controls.videoList.innerHTML = \"\";\n    }", "    controls.selectionCard.hidden = running || videos.length === 0;\n    if (videos.length === 0) {\n        controls.videoList.innerHTML = \"\";\n    }")

with open("popup.js", "w") as f:
    f.write(content)
