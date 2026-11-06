/** SVG images are inert in <img>, but scripts run if opened as a document.
 * A data URL has an opaque origin; a blob URL would inherit the app's origin.
 * Keep raster previews as revocable object URLs and isolate uploaded SVGs. */
export function imagePreviewUrl(blob: Blob): Promise<string> {
  if (blob.type !== "image/svg+xml") return Promise.resolve(URL.createObjectURL(blob));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Image could not be read."));
    reader.onerror = () => reject(new Error("Image could not be read."));
    reader.onabort = () => reject(new Error("Image read was cancelled."));
    reader.readAsDataURL(blob);
  });
}
