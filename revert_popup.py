import re
with open("popup.js", "r") as f:
    content = f.read()

# 1. controls addition
content = re.sub(r'  stop: document\.querySelector\("#stop-button"\),\n  filenamePattern:.*?\n  resume:.*?,', '  stop: document.querySelector("#stop-button"),', content, flags=re.DOTALL)

# 2. render additions
content = re.sub(r'  controls\.stop\.disabled = \!running \|\| \!flowTab;\n\n  controls\.pause\.hidden.*?\n  \}\n\}', '  controls.stop.disabled = !running || !flowTab;', content, flags=re.DOTALL)
content = re.sub(r'  controls\.stop\.disabled = \!running \|\| \!flowTab;\n\n.*?    \}\n  \}\n', '  controls.stop.disabled = !running || !flowTab;\n', content, flags=re.DOTALL)

# 3. issue modification
content = re.sub(r'async function issue\(message\) \{\n  if \(message\.type === "FLOW_START_BATCH".*?    \}\n  \}\n', 'async function issue(message) {\n', content, flags=re.DOTALL)

# 4. events addition
content = re.sub(r'controls\.stop\.addEventListener\("click", \(\) => issue\(\{ type: "FLOW_STOP_BATCH" \}\)\);\n\ncontrols\.selectAll\.addEventListener[\s\S]*?\)\);\n', 'controls.stop.addEventListener("click", () => issue({ type: "FLOW_STOP_BATCH" }));\n', content)

with open("popup.js", "w") as f:
    f.write(content)
