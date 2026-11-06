/** DOM ranges leave React's Markdown and streaming nodes untouched. Mirrored in Enterprise web. */
export const MATCH_LIMIT = 10_000;
export interface TextMatch { key: string; messageId: string; range: Range; root: HTMLElement; excerpt: string }
const ignored = 'script,style,svg,math,.katex-mathml,.sr-only,[hidden],[inert],[aria-hidden="true"]:not(.katex-html),[role="status"],[data-conversation-search-ignore]';
const block = 'p,pre,li,td,th,h1,h2,h3,h4,h5,h6,blockquote';

export function findTextMatches(container: HTMLElement, query: string): { matches: TextMatch[]; limited: boolean } {
  const matches: TextMatch[] = [];
  const value = query.trim();
  if (!value) return { matches, limited: false };
  const pattern = value.split(/\s+/u).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  for (const root of container.querySelectorAll<HTMLElement>('[data-conversation-search-text]')) {
    if (root.closest(ignored)) continue;
    const nodes: { node: Text; start: number; end: number }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = "", previousBlock: Element | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE) {
        if (node.nodeName === "BR" && !(node as Element).closest(ignored)) text += "\n";
        continue;
      }
      const parent = node.parentElement;
      if (!parent || parent.closest(ignored) || !node.textContent) continue;
      const currentBlock = parent.closest(block);
      if (nodes.length && currentBlock !== previousBlock) text += "\n";
      previousBlock = currentBlock;
      const start = text.length;
      text += node.textContent;
      nodes.push({ node: node as Text, start, end: text.length });
    }
    const owner = root.closest<HTMLElement>('[data-conversation-message]')?.dataset.conversationMessage ?? "message";
    const key = `${owner}:${root.dataset.conversationSearchText}`;
    let nodeIndex = 0;
    for (const hit of text.matchAll(new RegExp(pattern, "giu"))) {
      if (matches.length === MATCH_LIMIT) return { matches, limited: true };
      const start = hit.index, end = start + hit[0].length;
      while (nodeIndex < nodes.length && nodes[nodeIndex]!.end <= start) nodeIndex++;
      let endIndex = nodeIndex;
      while (endIndex < nodes.length && nodes[endIndex]!.end < end) endIndex++;
      const first = nodes[nodeIndex], last = nodes[endIndex];
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, Math.max(0, start - first.start));
      range.setEnd(last.node, end - last.start);
      matches.push({ key: `${key}:${start}`, messageId: owner, range, root, excerpt: text.slice(Math.max(0, start - 45), end + 90).replace(/\s+/g, " ").slice(0, 240) });
    }
  }
  return { matches, limited: false };
}

/** Scroll only the transcript and nested code blocks, never the app shell. */
export function revealMatch(match: TextMatch, viewport: HTMLElement) {
  if (!match.root.isConnected || !viewport.contains(match.root)) return;
  for (let el = match.range.startContainer.parentElement; el && el !== viewport; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) {
      const hit = match.range.getBoundingClientRect(), box = el.getBoundingClientRect();
      if (hit.left < box.left || hit.right > box.right) el.scrollLeft += hit.left - box.left - el.clientWidth / 2;
    }
  }
  const hit = match.range.getBoundingClientRect(), box = viewport.getBoundingClientRect();
  viewport.scrollTop += hit.top - box.top - viewport.clientHeight / 2 + hit.height / 2;
}

/** Preserve a visible message rather than total height, which also grows during streaming. */
export function captureScrollAnchor(viewport: HTMLElement | null): () => void {
  if (!viewport) return () => {};
  const top = viewport.getBoundingClientRect().top, scrollTop = viewport.scrollTop;
  const anchor = [...viewport.querySelectorAll<HTMLElement>('[data-conversation-message]')].find(node => node.getBoundingClientRect().bottom > top);
  if (!anchor) return () => {};
  const offset = anchor.getBoundingClientRect().top - top;
  return () => {
    if (!viewport.isConnected || !anchor.isConnected || !viewport.contains(anchor)) return;
    const movement = viewport.scrollTop - scrollTop;
    viewport.scrollTop += anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset + movement;
  };
}
