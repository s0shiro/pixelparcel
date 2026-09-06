import re
with open("content.js", "r") as f:
    content = f.read()

fallback_patch = """  async function resolveVideoInventory(force = false) {
    return fallbackVideoInventory();
  }"""

content = re.sub(r'  async function resolveVideoInventory\(force = false\) \{[\s\S]*?    \}\n  \}', fallback_patch, content)

with open("content.js", "w") as f:
    f.write(content)
