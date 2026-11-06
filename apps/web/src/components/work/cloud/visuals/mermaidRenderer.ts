export interface RenderedDiagram { svg: string; width: number; height: number }
let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Render offscreen, then display as an inert SVG image, never injected model DOM. */
export function renderMermaid(source: string, current: () => boolean): Promise<RenderedDiagram> {
  const task = queue.then(async () => {
    if (!current()) throw new Error("Diagram request was superseded.");
    if (source.length > 50000) throw new Error("Diagram source is too large.");
    const { default: mermaid } = await import("mermaid");
    if (!current()) throw new Error("Diagram request was superseded.");
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      htmlLabels: false, maxTextSize: 50000, maxEdges: 64,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "htmlLabels", "theme", "themeVariables", "flowchart", "look", "layout"],
      theme: "default",
    });
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, { position: "fixed", left: "-100000px", top: "0", width: "1200px", visibility: "hidden", pointerEvents: "none" });
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`lori-diagram-${++sequence}`, source, host);
      return inspectMermaidSvg(svg);
    } finally { host.remove(); }
  });
  queue = task.catch(() => {});
  return task;
}

/** Defensive output checks before creating a local image URL. */
export function inspectMermaidSvg(svg: string): RenderedDiagram {
  if (svg.length > 2_000_000) throw new Error("Diagram output is too large.");
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== "http://www.w3.org/2000/svg" || doc.querySelector("parsererror, script, foreignObject, iframe, object, embed, image, a")) throw new Error("Unsupported diagram output.");
  const attributes: string[] = [];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^(?:style|fill|stroke|filter|mask|clip-path|marker-start|marker-mid|marker-end)$/i.test(attribute.name)) attributes.push(attribute.value);
      if (/^on/i.test(attribute.name) || /^(?:href|xlink:href)$/i.test(attribute.name) && !attribute.value.startsWith("#")) throw new Error("Unsupported diagram action.");
    }
  }
  const styles = [...Array.from(doc.querySelectorAll("style"), element => element.textContent ?? ""), ...attributes];
  for (const style of styles) {
    if (/@import/i.test(style)) throw new Error("External diagram content is not allowed.");
    for (const match of style.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (!match[2]?.trim().startsWith("#")) throw new Error("External diagram content is not allowed.");
    }
  }
  const bounds = root.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  const width = bounds?.[2], height = bounds?.[3];
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 20000 || height > 20000) throw new Error("Invalid diagram size.");
  return { svg, width, height };
}
