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
    return { querySelector: (selector) => selector === "flow-video-tile" && type === "video" ? media : null, getAttribute: () => "Same prompt" };
  }
  const document = { querySelectorAll: () => [tile("one"), tile("two"), tile("picture", "image")] };
  const cards = Modern.videoCards(document, "https://flow.google.com");
  assert.equal(cards.length, 2);
  assert.notEqual(cards[0].mediaId, cards[1].mediaId);
  assert.ok(cards.every((card) => card.nativeMenu && card.title === "Same prompt"));
});
