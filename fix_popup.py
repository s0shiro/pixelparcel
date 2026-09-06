with open("popup.js", "r") as f:
    content = f.read()

import re

# Fix issue function
fixed_issue = """
async function issue(message) {
  try {
    await send(message);
    await refresh();
  } catch (error) {
    controls.pageStatus.textContent = error.message;
    controls.pageStatus.classList.add("error");
    controls.pageStatus.classList.remove("success");
  }
}
"""

content = re.sub(r'  try \{\n    await send\(message\);\n    await refresh\(\);\n  \} catch \(error\) \{[\s\S]*?\n  \}\n\}', fixed_issue, content)

# Remove resume listener
content = re.sub(r'controls\.resume\.addEventListener\("click", \(\) => issue\(\{ type: "FLOW_RESUME_BATCH" \}\)\);\n', '', content)

with open("popup.js", "w") as f:
    f.write(content)
