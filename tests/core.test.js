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
