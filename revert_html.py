with open("popup.html", "r") as f:
    html = f.read()

import re
html = re.sub(r'      <section id="settings-card" class="settings-card">.*?</section>\n\n', '', html, flags=re.DOTALL)
html = re.sub(r'      <section id="selection-card" class="selection-card" hidden>.*?</section>\n\n', '', html, flags=re.DOTALL)
html = re.sub(r'        <button id="pause-button".*?</button>\n', '', html)
html = re.sub(r'        <button id="resume-button".*?</button>\n', '', html)
html = html.replace('Download selected 720p', 'Download 720p')
html = html.replace('Upscale + download selected 1080p', 'Upscale + download 1080p')

with open("popup.html", "w") as f:
    f.write(html)
