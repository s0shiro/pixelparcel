import re
with open("content.js", "r") as f:
    content = f.read()

fetch_patch = """    const response = await chrome.runtime.sendMessage({
      type: "FLOW_FETCH_INVENTORY",
      projectId: projectId
    });
    if (!response.ok) throw new Error(`Flow project inventory returned an error.`);
    const payload = response.payload;"""

content = re.sub(r'    const input = encodeURIComponent\(JSON\.stringify\(\{ json: \{ projectId \} \}\)\);\n    const response = await fetch\(`https://labs\.google/fx/api/trpc/flow\.projectInitialData\?input=\$\{input\}`.*?\);\n    if \(\!response\.ok\) throw new Error\(`Flow project inventory returned HTTP \$\{response\.status\}\.`\);\n    const payload = await response\.json\(\);', fetch_patch, content, flags=re.DOTALL)

with open("content.js", "w") as f:
    f.write(content)
