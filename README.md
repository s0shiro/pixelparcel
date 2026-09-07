# PixelParcel for Google Flow™

A small Manifest V3 Chrome extension with only two export jobs:

- Download every video in the current Google Flow project at **720p**.
- Use Google Flow's own export menu to **upscale and download every video at 1080p**.

The extension does not generate media, remove watermarks, bypass account restrictions, or call an unofficial upscale service.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `pixelparcel` directory.
5. Open a Google Flow project and reload the Flow tab once.
6. Click the extension icon.

After updating, click **Reload** for this extension in `chrome://extensions`, confirm version **1.9.3**, then refresh the Flow project tab. Both `flow.google.com` and the Flow routes on `labs.google`, including language-prefixed URLs, are recognized. Reloading only the panel does not update an already-injected content script.

Clicking the extension icon opens a persistent Chrome side panel instead of a small popup. The panel stays open beside Flow and can be resized by dragging its inner edge.

If the popup reports that it cannot read the tab's address or connect to Flow, check the extension's **Details → Site access** and allow access to your Flow site. Select the project tab before clicking the extension icon. The popup only controls the selected tab; it never silently chooses another open project.

## Use

1. Open the Flow project containing the videos.
2. Optionally click **Scan project** to count the videos.
3. Click **Download all 720p**, or **Upscale + download all 1080p**.
4. Keep that Flow tab open until the job finishes. You may close the extension popup.
5. If Chrome asks whether `labs.google` may download multiple files, choose **Allow**.

On the current Flow grid, use the round selector added at the upper-left of a video card to select individual videos. The selector is kept outside Flow's clickable card, so clicking it selects the video without opening or playing it. Shift-click selects a range after the grid has been scanned. Use the floating bar or the popup to export only the selection.

Every selected video is downloaded whenever a job runs. The extension does not inspect Chrome's download history or skip files that have been downloaded before.

By default, every export goes into the single folder `Downloads/Flow Videos/`. The popup shows the exact destination before you start. Turn off **Save every exported video in one folder** to save directly in `Downloads/`, or type a different folder name. A `/` creates nested folders only when you enter it intentionally.

If an export fails, the popup keeps a **Failed videos** report containing the item's batch number, Flow title, and failure reason. Click **Retry failed videos** to rerun only those video identities at the same resolution without reprocessing successful downloads. Videos with identical titles remain separate entries on the new Flow app.

On the older Labs interface, the scanner reads the project inventory through the extension's background worker, with grid scanning as a fallback. On the new Flow interface, it scans the virtualized video grid and uses each video's native download menu for both 720p and 1080p. It does not send the old Labs API requests from `flow.google.com`.

Before scanning the new interface, open the project's **Videos** view and clear any search or filter applied inside Google Flow. The extension itself has no filter: it exports the checked videos, or every video when none are checked. Only completed video tiles in the current project/collection view are included; hidden nested collections and older versions inside an edit stack are not traversed. Scanning scrolls through the loaded view and restores the original position afterward. Keep the project tab in the foreground while exporting. The requested resolution must actually be available in Flow's menu—360p or 1080p originals are never silently renamed as 720p.

Native downloads are counted after Chrome reports completion, not just when they start. Interrupted downloads are recorded for retry. Temporary download watches survive the extension service worker going idle. Only one native export job is monitored at a time; avoid manually downloading other media from Flow during a batch. Press **Stop** in the popup or `Esc` in the Flow tab to stop the extension; this does not cancel an upscale already running on Google's servers. Check Chrome Downloads before retrying a timed-out item to avoid duplicates.

The extension downloads video files only; it does not create metadata JSON sidecars.

Research findings and verification limits are recorded in [COMPATIBILITY.md](COMPATIBILITY.md).

## Notes

- Google Flow calls its standard export **720p**, not 780p.
- 1080p uses the resolution offered in each video's own Flow download menu. It requires an eligible Google AI account and may be unavailable for particular assets, models, regions, or account types.
- Upscale exports are intentionally processed one at a time. A single 1080p item can take several minutes.
- The extension operates by using Flow's visible asset menus. If Google changes those menus, the extension will report that the resolution or menu could not be found instead of clicking a guessed control.
- Generated Flow videos retain Google's SynthID watermark.

Official references:

- [Download media from Google Flow](https://support.google.com/labs/answer/16935308)
- [Google Flow models and supported resolutions](https://support.google.com/flow/answer/16352836)
- [Google Flow credit and upscale availability](https://support.google.com/flow/answer/16526234)

## Development checks

```bash
npm test
npm run check
npm run test:browser
```
