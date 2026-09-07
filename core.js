(function initializeFlowBulkCore(globalScope) {
  "use strict";

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeResolutionId(value) {
    const text = compactText(value).toLowerCase();
    const resolution = text.match(/\b(\d{3,4}p|[48]k)\b/i)?.[1];
    if (resolution) return resolution.toLowerCase();
    const factor = text.match(/\b(1x|2x|4x)\b/i)?.[1];
    if (factor) return factor.toLowerCase();
    if (/\boriginal\b/i.test(text)) return "original";
    if (/\bupscal/i.test(text)) return "1080p";
    return text.replace(/\s+/g, "-");
  }

  function isDisabledElement(element) {
    if (!element) return true;
    return element.getAttribute?.("aria-disabled") === "true"
      || element.hasAttribute?.("data-disabled")
      || element.disabled === true;
  }

  function selectResolutionCandidate(candidates, requested, originalHeight) {
    const requestedId = normalizeResolutionId(requested);
    const available = candidates.filter((candidate) => !candidate.disabled);
    const exact = available.find(
      (candidate) => normalizeResolutionId(candidate.text) === requestedId,
    );
    if (exact) return exact;

    if (requestedId === "720p" && Number(originalHeight) === 720) {
      return available.find((candidate) => {
        const id = normalizeResolutionId(candidate.text);
        return id === "original" || id === "1x";
      }) || null;
    }

    return null;
  }

  function stableUrl(value, baseUrl) {
    if (!value) return "";
    if (String(value).startsWith("blob:")) return String(value);
    try {
      const parsed = new URL(value, baseUrl);
      for (const name of [...parsed.searchParams.keys()]) {
        if (/^(?:x-goog-|signature$|sig$|expire$|expires$|token$|key-pair-id$)/i.test(name)) {
          parsed.searchParams.delete(name);
        }
      }
      parsed.hash = "";
      parsed.searchParams.sort();
      return parsed.toString();
    } catch {
      return String(value);
    }
  }

  function assetKeyFromVideo(video, baseUrl) {
    const candidates = [
      video?.currentSrc,
      video?.getAttribute?.("src"),
      ...[...(video?.querySelectorAll?.("source") || [])].map(
        (source) => source.src || source.getAttribute("src"),
      ),
      video?.poster,
    ].filter(Boolean);

    if (candidates.length) return `url:${stableUrl(candidates[0], baseUrl)}`;

    let current = video;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      for (const attribute of ["data-asset-id", "data-generation-id", "data-media-id"]) {
        const value = current.getAttribute?.(attribute);
        if (value) return `${attribute}:${value}`;
      }
    }

    if (video?.dataset) {
      video.dataset.flowBulkAssetKey ||= `dom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      return video.dataset.flowBulkAssetKey;
    }
    return "";
  }

  function safeFilename(value, fallback) {
    const cleaned = compactText(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/[. ]+$/g, "")
      .slice(0, 90);
    return cleaned || fallback;
  }

  function sanitizeFolder(value, fallback = "Flow_Export") {
    const cleaned = compactText(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 80);
    return cleaned || fallback;
  }

  function sanitizeFolderPath(value, fallback = "Flow_Export") {
    const raw = compactText(value).replace(/\\/g, "/");
    if (!raw) return fallback;
    const segments = raw.split("/")
      .map((seg) => sanitizeFolder(seg, ""))
      .filter((seg) => Boolean(seg) && seg !== "." && seg !== "..");
    return segments.length > 0 ? segments.join("/") : fallback;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "--:--";
    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function isFlowPage(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      if (parsed.hostname === "flow.google.com") return true;
      return parsed.hostname === "labs.google"
        && /^\/fx\/(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/)?(?:tools\/)?flow(?:\/|$)/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  const api = {
    assetKeyFromVideo,
    compactText,
    formatDuration,
    isDisabledElement,
    isFlowPage,
    normalizeResolutionId,
    safeFilename,
    sanitizeFolder,
    sanitizeFolderPath,
    selectResolutionCandidate,
    stableUrl,
  };

  globalScope.FlowBulkCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
