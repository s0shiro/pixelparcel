# Flow compatibility repair — 2026-09-06

## What was verified

Google is currently serving different frontends at [Flow](https://flow.google.com/) and [Labs Flow](https://labs.google/fx/tools/flow). The public Labs page loads Next.js assets. The new Flow page loads `AiSandboxAngularFrontend`; its public project/grid modules are named `wO1vlb` and `XRV0Af` in build `9glrdg-UnhA.2018.O`.

The new grid module uses `flow-grid-tile-container`, `flow-video-tile`, `flow-menu-item`, and `cdk-virtual-scroll-viewport`. Video tiles use preview thumbnails and can defer the actual video element until hover. The new app uses different backend services, including `FlowService.ListMedia` and `FlowService.GetMediaUrl`, rather than the old `flow.projectInitialData` tRPC request. These details were inspected in Google's own publicly served JavaScript; no authenticated requests, generation requests, account credentials, or private APIs were replayed.

Google's [current download instructions](https://support.google.com/flow/answer/16935308?hl=en) still direct users to an asset's More → Download menu. The served menu code distinguishes original resolution and permitted upscale options, including 360p, 720p, 1080p, and 4K; availability is asset/account dependent. The extension reads the actual menu instead of assuming every original is 720p.

Chrome documents that [content scripts remain subject to cross-origin request rules](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), even when an extension declares host permissions. Adding the new hostname in v1.6.1 therefore did not make the old Labs request compatible with the new app. “Failed to fetch” alone does not prove CORS: connectivity and request blocking can also cause it.

## Changes in 1.7.0

- Separate new-Flow grid adapter; no legacy inventory, classification, or media-redirect calls on that interface.
- Legacy inventory request moved into the extension worker, using a fixed URL, validated project ID, credentials, a timeout, and actionable errors.
- Thumbnail-based video identity, independent of duplicate prompts and thumbnail resizing.
- Native resolution selection restricted to open menus/dialogs, with support for the new menu wrappers.
- Chrome download completion/interruption tracking and session-backed watches, following the [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads) and [session storage](https://developer.chrome.com/docs/extensions/reference/api/storage) documentation.
- A successful legacy grid fallback clears the earlier request error. Time-limited scans are reported as incomplete. Upscale render time no longer consumes the grid scan's time budget.

## Verification limits

Tests use simulated legacy and Angular Flow grids in headless Chrome, plus isolated popup, background-worker, and URL/identity tests. The Angular fixture reflects selectors and menu structures found in Google's current code and includes virtualization, duplicate titles, resolution refusal, failed-only retries, and long render times.

The assistant did not have a connection to the user's authenticated Flow tab. These tests do not establish that a real download or upscale completed on the user's account. After reloading the extension and Flow tab, the first live check is Scan project, followed by a download on a small project/collection. If it fails, report the exact message and which button was used.

The new adapter scans the current filtered project/collection grid. It does not recursively traverse hidden collections or older edit-stack versions. Google may change this UI again; these are observed implementation details, not a supported public API contract.
