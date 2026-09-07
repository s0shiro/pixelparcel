"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
require("../core.js");
const Modern = require("../modern-flow.js");

test("modern adapter recognizes the new origin and Angular component markers", () => {
  assert.equal(Modern.isModernPage({ querySelector: () => null }, "https://flow.google.com/project/id"), true);
  assert.equal(Modern.isModernPage({ querySelector: () => ({}) }, "https://labs.google/fx/tools/flow"), true);
  assert.equal(Modern.isModernPage({ querySelector: () => null }, "https://labs.google/fx/tools/flow"), false);
});

test("modern video identity survives resized and re-signed thumbnails", () => {
  assert.equal(
    Modern.thumbnailKey("https://lh3.googleusercontent.com/video-one=s512-rw?token=old", "https://flow.google.com"),
    Modern.thumbnailKey("https://lh3.googleusercontent.com/video-one=s1600-rw?token=new", "https://flow.google.com"),
  );
  assert.notEqual(
    Modern.thumbnailKey("https://lh3.googleusercontent.com/video-one=s512-rw", "https://flow.google.com"),
    Modern.thumbnailKey("https://lh3.googleusercontent.com/video-two=s512-rw", "https://flow.google.com"),
  );
  assert.equal(Modern.thumbnailKey("data:image/png;base64,placeholder", "https://flow.google.com"), "");
});

test("modern scan identifies thumbnails without treating duplicate titles as the same video", () => {
  function tile(id, type = "video") {
    const media = {
      querySelector(selector) {
        if (selector === "img.thumbnail, img") return { getAttribute: () => `https://lh3.googleusercontent.com/${id}=s512-rw` };
        return null;
      },
    };
    return {
      querySelector: (selector) => selector === "flow-video-tile" && type === "video" ? media : null,
      getAttribute: () => `${id}_video.mp4`,
    };
  }
  const document = { querySelectorAll: () => [tile("one"), tile("two"), tile("picture", "image")] };
  const cards = Modern.videoCards(document, "https://flow.google.com");
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].mediaId, cards[1].mediaId);
  assert.ok(cards.every((card) => card.nativeMenu));
  assert.equal(cards[0].title, "one_video.mp4");
  assert.equal(cards[1].title, "two_video.mp4");
});

test("modern scan respects visibility predicate and aria-label keys", () => {
  function tile(ariaLabel, isVisible) {
    const media = {
      querySelector: () => null,
      visible: isVisible,
    };
    return {
      querySelector: (selector) => selector === "flow-video-tile" ? media : null,
      getAttribute: (attr) => attr === "aria-label" ? ariaLabel : null,
    };
  }
  const document = {
    querySelectorAll: () => [
      tile("video_01.mp4", true),
      tile("video_02.mp4", false),
      tile("video_03.mp4", true),
    ],
  };
  const cards = Modern.videoCards(document, "https://flow.google.com", (el) => el.visible);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].mediaId, "flow-label:video_01.mp4");
  assert.equal(cards[1].mediaId, "flow-label:video_03.mp4");
});

test("modern scan prefers stable media attributes over changing thumbnails", () => {
  const media = { querySelector: () => null, getAttribute: () => null };
  const tile = {
    querySelector(selector) {
      if (selector === "flow-video-tile") return media;
      return null;
    },
    getAttribute(attribute) {
      if (attribute === "data-media-id") return "stable-video-id";
      if (attribute === "aria-label") return "A video";
      return null;
    },
  };
  const cards = Modern.videoCards({ querySelectorAll: () => [tile] }, "https://flow.google.com");
  assert.equal(cards[0].mediaId, "flow-media:stable-video-id");
});
