"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isFlowPage,
  normalizeResolutionId,
  safeFilename,
  selectResolutionCandidate,
  stableUrl,
} = require("../core.js");

test("normalizes Flow resolution menu labels", () => {
  assert.equal(normalizeResolutionId("1080p (Upscale)"), "1080p");
  assert.equal(normalizeResolutionId("Upscaled"), "1080p");
  assert.equal(normalizeResolutionId("Download original"), "original");
  assert.equal(normalizeResolutionId("4K · Ultra"), "4k");
});

test("selects an exact available resolution", () => {
  const candidates = [
    { text: "720p", disabled: false },
    { text: "1080p Upscale", disabled: false },
    { text: "4K", disabled: true },
  ];
  assert.equal(selectResolutionCandidate(candidates, "1080p", 720), candidates[1]);
  assert.equal(selectResolutionCandidate(candidates, "4k", 720), null);
});

test("uses Original only when the source is known to be 720p", () => {
  const original = { text: "Original", disabled: false };
  assert.equal(selectResolutionCandidate([original], "720p", 720), original);
  assert.equal(selectResolutionCandidate([original], "720p", 360), null);
});

test("recognizes supported Flow routes", () => {
  assert.equal(isFlowPage("https://labs.google/fx/tools/flow/project/abc"), true);
  assert.equal(isFlowPage("https://labs.google/fx/flow/project/abc"), true);
  assert.equal(isFlowPage("https://labs.google/fx/en/tools/flow/project/abc"), true);
  assert.equal(isFlowPage("https://labs.google/fx/pt-BR/flow/project/abc"), true);
  assert.equal(isFlowPage("https://flow.google.com/"), true);
  assert.equal(isFlowPage("https://flow.google.com/project/abc"), true);
  assert.equal(isFlowPage("https://example.com/fx/tools/flow/project/abc"), false);
  assert.equal(isFlowPage("https://flow.google.com.example.com/"), false);
  assert.equal(isFlowPage("http://flow.google.com/"), false);
  assert.equal(isFlowPage("https://labs.google/fx/tools/flower"), false);
  assert.equal(isFlowPage("https://labs.google/fx/tools/whisk"), false);
  assert.equal(isFlowPage(undefined), false);
});

test("removes expiring signature fields from stable URLs", () => {
  assert.equal(
    stableUrl("https://flow-content.google/video.mp4?x-goog-signature=secret&id=42", "https://labs.google"),
    "https://flow-content.google/video.mp4?id=42",
  );
});

test("creates safe download names", () => {
  assert.equal(safeFilename('Shot 1: Luna / Elias?', "fallback"), "Shot 1- Luna - Elias-");
});

test("sanitizes folder names", () => {
  const { sanitizeFolder, sanitizeFolderPath } = require("../core.js");
  assert.equal(sanitizeFolder("My: Project / Season 1?"), "My_ Project _ Season 1_");
  assert.equal(sanitizeFolder(""), "Flow_Export");

  assert.equal(sanitizeFolderPath("Flow/Season 1: Pilot?"), "Flow/Season 1_ Pilot_");
  assert.equal(sanitizeFolderPath("/Leading/Slash/.."), "Leading/Slash");
  assert.equal(sanitizeFolderPath(""), "Flow_Export");
  assert.equal(sanitizeFolderPath("   "), "Flow_Export");
});

test("formats elapsed and ETA durations cleanly", () => {
  const { formatDuration } = require("../core.js");
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(45000), "00:45");
  assert.equal(formatDuration(135000), "02:15");
  assert.equal(formatDuration(3665000), "1:01:05");
  assert.equal(formatDuration(-1), "--:--");
  assert.equal(formatDuration(NaN), "--:--");
});

test("parses index ranges and matches filters", () => {
  const { parseIndexRanges, matchesFilter } = require("../core.js");
  const ranges = parseIndexRanges("1-3, 5, 8-10");
  assert.deepEqual([...ranges].sort((a, b) => a - b), [1, 2, 3, 5, 8, 9, 10]);
  assert.equal(parseIndexRanges("EP02"), null);

  // Range matching (1-based index)
  assert.equal(matchesFilter({ title: "Shot A" }, 0, "1-3"), true); // index 0 is #1
  assert.equal(matchesFilter({ title: "Shot B" }, 3, "1-3"), false); // index 3 is #4

  // Text matching
  assert.equal(matchesFilter({ title: "EP02_Scene1.mp4" }, 0, "ep02"), true);
  assert.equal(matchesFilter({ title: "EP01_Scene1.mp4" }, 0, "ep02"), false);
  assert.equal(matchesFilter({ title: "Shot A" }, 0, ""), true);
});
