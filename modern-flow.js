(function initializeModernFlow(globalScope) {
  "use strict";

  const Core = globalScope.FlowBulkCore;

  function isModernPage(document, url) {
    try {
      if (new URL(url).hostname === "flow.google.com") return true;
    } catch {}
    return Boolean(document.querySelector("aisandbox-root, flow-grid-tile-container"));
  }

  function thumbnailKey(source, baseUrl) {
    if (!source || /^(?:data:|blob:)/i.test(source)) return "";
    const url = new URL(Core.stableUrl(source, baseUrl));
    // Google's thumbnail size may change when the user changes the grid size.
    if (url.hostname.endsWith(".googleusercontent.com")) {
      url.pathname = url.pathname.replace(/=[swh]\d+[a-z0-9-]*$/i, "");
    }
    return `flow-tile:${url.toString()}`;
  }

  function videoCards(document, baseUrl, visible = () => true) {
    const cards = new Map();
    // These are the components served by Flow's Angular media-grid module.
    // Scope discovery to grid tiles, excluding editor previews and dialogs.
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const media = tile.querySelector("flow-video-tile") || tile.querySelector("video")?.parentElement;
      if (!media || !visible(media) || media.querySelector("flow-pending-tile, flow-error-tile")) continue;
      const thumbnail = media.querySelector("img.thumbnail, img");
      const video = media.querySelector("video");
      const source = thumbnail?.getAttribute("src") || thumbnail?.currentSrc || video?.poster || video?.src || video?.currentSrc;
      const explicitId = media.querySelector("[data-media-id]")?.getAttribute("data-media-id");
      const ariaLabel = tile.getAttribute("aria-label");
      const thumbKey = thumbnailKey(source, baseUrl);
      const mediaId = explicitId ? `flow-media:${explicitId}` : (thumbKey || (ariaLabel ? `flow-label:${ariaLabel}` : ""));
      if (!mediaId || cards.has(mediaId)) continue;
      cards.set(mediaId, {
        mediaId,
        title: Core.compactText(tile.getAttribute("aria-label")
          || tile.querySelector("flow-editable-text")?.textContent
          || tile.querySelector("[aria-label*='.mp4' i]")?.getAttribute("aria-label")
          || [...tile.querySelectorAll("*")].find((el) => /\.mp4\b/i.test(el.textContent))?.textContent),
        tile,
        surface: media,
        video,
        nativeMenu: true,
      });
    }
    return [...cards.values()];
  }

  const api = { isModernPage, thumbnailKey, videoCards };
  globalScope.FlowModernDom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
