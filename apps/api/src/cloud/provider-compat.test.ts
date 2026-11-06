import { afterEach, describe, expect, it } from "vitest";
import {
  forgetReasoningCompat,
  hasImages,
  imagesDisabledFor,
  rejectsImages,
  rememberImagesDisabled,
  withoutImages,
} from "./provider-compat.js";

const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
const body = {
  model: "text-model",
  messages: [
    { role: "user", content: "Build a deck" },
    { role: "user", content: [{ type: "text", text: "Rendered page 1" }, image] },
  ],
};

describe("images for text-only models", () => {
  afterEach(forgetReasoningCompat);

  it("recognizes a refusal of image input and nothing else", () => {
    expect(rejectsImages('{"error":{"code":"model_not_capable"}}')).toBe(true);
    expect(rejectsImages("This model does not support image input")).toBe(true);
    expect(rejectsImages("max_tokens is too large")).toBe(false);
  });
  it("does not blame the model for one bad file", () => {
    expect(rejectsImages("This model does not support image format bmp")).toBe(false);
    expect(rejectsImages("The image is too large")).toBe(false);
  });
  it("replaces each image with a note and keeps everything else", () => {
    const stripped = withoutImages(body) as typeof body;
    expect(hasImages(stripped)).toBe(false);
    expect(JSON.stringify(stripped)).not.toContain("base64");
    expect(stripped.messages[0]).toBe(body.messages[0]);
    expect((stripped.messages[1]!.content as { text: string }[])[0]!.text).toBe("Rendered page 1");
    expect((stripped.messages[1]!.content as { text: string }[])[1]!.text).toMatch(/cannot view images/);
  });
  it("returns a request without images untouched", () => {
    const plain = { messages: [{ role: "user", content: "Hello" }] };
    expect(withoutImages(plain)).toBe(plain);
    expect(withoutImages({})).toEqual({});
  });
  it("remembers a model per provider connection, for a limited time", () => {
    rememberImagesDisabled("connection-a", "text-model", 1000);
    expect(imagesDisabledFor("connection-a", "text-model", 2000)).toBe(true);
    expect(imagesDisabledFor("connection-b", "text-model", 2000)).toBe(false);
    expect(imagesDisabledFor("connection-a", "text-model", 1000 + 7 * 60 * 60 * 1000)).toBe(false);
  });
});
