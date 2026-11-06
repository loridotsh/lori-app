import { describe, expect, it } from "vitest";
import { captureScrollAnchor, findTextMatches, MATCH_LIMIT } from "./textMatches";

function transcript(html: string) {
  const container = document.createElement("div");
  container.innerHTML = `<article data-conversation-message="one"><div data-conversation-search-text="answer">${html}</div></article>`;
  return container;
}

describe("conversation text search", () => {
  it("anchors the visible message across prepends without undoing the reader's scroll", () => {
    const viewport = transcript('<p>Visible message</p>');
    document.body.append(viewport);
    const row = viewport.querySelector<HTMLElement>('article')!;
    let contentTop = 250;
    viewport.scrollTop = 50;
    viewport.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    row.getBoundingClientRect = () => ({ top: contentTop - viewport.scrollTop, bottom: contentTop - viewport.scrollTop + 100 }) as DOMRect;
    const restore = captureScrollAnchor(viewport);
    contentTop += 200;
    viewport.scrollTop += 20;
    restore();
    expect(viewport.scrollTop).toBe(270);
    viewport.remove();
  });
  it("finds literal case-insensitive phrases across inline formatting without changing markup", () => {
    const root = transcript('<p>The <strong>launch</strong> date is Friday. LAUNCH date is confirmed.</p>');
    const html = root.innerHTML;
    const result = findTextMatches(root, "launch date");
    expect(result.matches.map(hit => hit.range.toString())).toEqual(["launch date", "LAUNCH date"]);
    expect(root.innerHTML).toBe(html);
  });
  it("handles regex characters, emoji, accents, RTL text and repeated matches", () => {
    const root = transcript('<p>💡 Budget: $1.50 (net) [ok] Café café مراجعة</p>');
    for (const query of ["💡", "$1.50 (net)", "[ok]", "مراجعة"]) {
      expect(findTextMatches(root, query).matches[0]?.range.toString()).toBe(query);
    }
    expect(findTextMatches(root, "CAFÉ").matches).toHaveLength(2);
    expect(findTextMatches(root, "  ").matches).toHaveLength(0);
  });
  it("excludes tool chrome, hidden content and accessibility announcements", () => {
    const root = transcript('<div data-conversation-search-ignore>needle</div><span class="sr-only">needle</span><span aria-hidden="true">needle</span><span hidden>needle</span><span role="status">needle</span><p>needle</p>');
    root.insertAdjacentHTML("beforeend", '<div>needle in tool activity</div>');
    expect(findTextMatches(root, "needle").matches).toHaveLength(1);
  });
  it("separates paragraphs while preserving phrases and does not match across messages", () => {
    expect(findTextMatches(transcript('<p>first<br>second</p>'), "first second").matches).toHaveLength(1);
    const root = transcript('<p>one</p><p>two</p>');
    expect(findTextMatches(root, "onetwo").matches).toHaveLength(0);
    expect(findTextMatches(root, "one two").matches).toHaveLength(1);
    root.insertAdjacentHTML("beforeend", '<article data-conversation-message="two"><p data-conversation-search-text="user">three</p></article>');
    expect(findTextMatches(root, "two three").matches).toHaveLength(0);
  });
  it("keeps match identities stable when earlier pages are prepended", () => {
    const root = transcript('<p>needle needle</p>');
    const keys = findTextMatches(root, "needle").matches.map(hit => hit.key);
    root.insertAdjacentHTML("afterbegin", '<article data-conversation-message="older"><p data-conversation-search-text="user">needle</p></article>');
    expect(findTextMatches(root, "needle").matches.slice(1).map(hit => hit.key)).toEqual(keys);
  });
  it("bounds excessively broad searches and reports the partial count", () => {
    const root = transcript(`<p>${"x ".repeat(MATCH_LIMIT + 1)}</p>`);
    const result = findTextMatches(root, "x");
    expect(result.matches).toHaveLength(MATCH_LIMIT);
    expect(result.limited).toBe(true);
  });
});
