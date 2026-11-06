import type { CloudVisual } from "@lori-enterprise/contracts";

const fileName = (title: string) => title.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 80) || "artifact";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name;
  document.body.append(anchor);
  try { anchor.click(); }
  finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export async function exportVisual(visual: CloudVisual) {
  // Text and JSON remain inert files. The JSON contains the original snapshot,
  // never the member's local quiz answers or calculator values.
  download(new Blob([JSON.stringify(visual, null, 2)], { type: "application/json" }), `${fileName(visual.title)}.json`);
  return true;
}

export async function exportImage(title: string, image: Blob) {
  download(image, `${fileName(title)}.png`);
  return true;
}
