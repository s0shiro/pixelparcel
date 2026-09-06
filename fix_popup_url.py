import re
with open("popup.js", "r") as f:
    c = f.read()
c = re.sub(r'  function isFlowUrl\(url\) \{[\s\S]*?  \}', '  function isFlowUrl(url) {\n    try {\n      const parsed = new URL(url);\n      return parsed.hostname === "labs.google"\n        && (/^\\/fx\\/tools\\/flow(?:\\/|$)/.test(parsed.pathname)\n          || /^\\/fx\\/flow(?:\\/|$)/.test(parsed.pathname));\n    } catch {\n      return false;\n    }\n  }', c)
with open("popup.js", "w") as f:
    f.write(c)
