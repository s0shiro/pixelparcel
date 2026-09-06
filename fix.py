with open("content.js", "r") as f:
    c = f.read()

c = c.replace("    state.lastError = \"\";\n  });\n  }", "    state.lastError = \"\";\n  }")

with open("content.js", "w") as f:
    f.write(c)
