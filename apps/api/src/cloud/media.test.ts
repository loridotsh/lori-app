import { describe, expect, it } from "vitest";
import { mediaPath, mediaPrompt } from "./media.js";

describe("mediaPrompt", () => {
  it("uses only the newest member message", () => {
    expect(mediaPrompt([
      { role: "system", content: "Rules" },
      { role: "user", content: "A red fox" },
      { role: "assistant", content: "Done" },
      { role: "user", content: "  A paper boat  " },
    ])).toBe("A paper boat");
  });
  it("joins the text parts of a structured message and skips the rest", () => {
    expect(mediaPrompt([{ role: "user", content: [
      { type: "text", text: "A paper boat" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
      { type: "text", text: "in the rain" },
    ] }])).toBe("A paper boat\nin the rain");
  });
  it("returns nothing when there is no member text", () => {
    expect(mediaPrompt([{ role: "assistant", content: "Hello" }])).toBe("");
    expect(mediaPrompt("not a list")).toBe("");
  });
});

describe("mediaPath", () => {
  it("names the file after the prompt and keeps repeats apart", () => {
    const first = mediaPath("A Red Fox, in the snow!", "image", "png");
    expect(first).toMatch(/^generated\/a-red-fox-in-the-snow-[0-9a-f]{8}\.png$/);
    expect(mediaPath("A Red Fox, in the snow!", "image", "png")).not.toBe(first);
  });
  it("falls back to the kind when the prompt has no usable letters", () => {
    expect(mediaPath("夕焼けの海", "video", "mp4")).toMatch(/^generated\/video-[0-9a-f]{8}\.mp4$/);
  });
  it("keeps long prompts to a short name with no trailing dash", () => {
    const name = mediaPath(`${"a".repeat(47)} ${"b".repeat(60)}`, "video", "mp4").slice("generated/".length);
    expect(name).toMatch(/^a{47}-[0-9a-f]{8}\.mp4$/);
  });
});
