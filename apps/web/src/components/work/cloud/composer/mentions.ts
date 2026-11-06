export type MentionKind = "file" | "plugin" | "skill";

export interface MentionOption {
  id: string;
  kind: MentionKind;
  /** What the picker shows and what the message will contain after the "@". */
  label: string;
  detail?: string;
  /** Plugin ID, so the picker can show the service's logo. */
  pluginId?: string;
}

export interface MentionQuery {
  /** Index of the "@". */
  start: number;
  /** Caret position: where the typed query ends. */
  end: number;
  query: string;
}

/** `@` only starts a mention at the start of a line or after whitespace or an opening bracket, so emails are left alone. */
const TRIGGER = /(?:^|[\s([{])@("[^"\n]*"?|[^\s@"\n]*)$/;

export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = TRIGGER.exec(before);
  if (!match) return null;
  const raw = match[1] ?? "";
  const start = caret - raw.length - 1;
  return { start, end: caret, query: raw.replace(/^"/, "").replace(/"$/, "") };
}

const KIND_ORDER: Record<MentionKind, number> = { file: 0, plugin: 1, skill: 2 };

function score(option: MentionOption, needle: string): number {
  const label = option.label.toLowerCase();
  const name = label.split("/").at(-1) ?? label;
  if (!needle) return 3;
  if (label === needle || name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (label.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (label.includes(needle)) return 3;
  return Number.POSITIVE_INFINITY;
}

/** Best matches first; with no query, everything grouped files, plugins, skills. */
export function filterMentions(
  options: MentionOption[],
  query: string,
  limit = 50,
): MentionOption[] {
  const needle = query.trim().toLowerCase();
  return options
    .map((option, index) => ({ option, index, rank: score(option, needle) }))
    .filter((item) => Number.isFinite(item.rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        KIND_ORDER[a.option.kind] - KIND_ORDER[b.option.kind] ||
        a.option.label.localeCompare(b.option.label) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map((item) => item.option);
}

/** The text a mention becomes: quoted when it contains whitespace, so it stays one token. */
export function mentionText(option: MentionOption): string {
  return /[\s"@\\]|[.,;:!?)\]}]$/.test(option.label) ? `@${JSON.stringify(option.label)}` : `@${option.label}`;
}

export function applyMention(
  text: string,
  query: MentionQuery,
  option: MentionOption,
): { text: string; caret: number } {
  const insert = `${mentionText(option)} `;
  // Replacing a query in the middle of a token must also replace its suffix.
  let end = query.end;
  if (text[query.start + 1] === '"') {
    const token = /^"(?:[^"\\\n]|\\.)*"/.exec(text.slice(query.start + 1));
    if (token) end = Math.max(end, query.start + 1 + token[0].length);
  } else {
    const suffix = /^[^\s@"]*/.exec(text.slice(end))?.[0] ?? "";
    end += suffix.replace(/[.,;:!?)\]}]+$/, "").length;
  }
  const after = text.slice(end);
  const next = `${text.slice(0, query.start)}${insert}${after.startsWith(" ") ? after.slice(1) : after}`;
  return { text: next, caret: query.start + insert.length };
}

export type MentionSegment = { text: string; mention: boolean };

/**
 * Splits a message so tokens that exactly match something that can be
 * mentioned can be highlighted. Anything else, such as an email address, stays plain.
 */
export function mentionOccurrences(text: string, known: string[]): Array<{ start: number; end: number; label: string }> {
  const lookup = new Map(known.map(label => [label, label]));
  const folded = new Map<string, string[]>();
  for (const label of new Set(known)) folded.set(label.toLowerCase(), [...(folded.get(label.toLowerCase()) ?? []), label]);
  const result: Array<{ start: number; end: number; label: string }> = [];
  const pattern = /(^|[\s([{])(@"(?:[^"\\\n]|\\.)*"(?=$|[\s.,;:!?)\]}])|@[^\s@"]+)(?![^\s.,;:!?)\]}])/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const token = match[2]!;
    const quoted = token.startsWith('@"');
    let raw: string;
    try { raw = quoted ? JSON.parse(token.slice(1)) as string : token.slice(1); } catch { continue; }
    const resolve = (name: string) => lookup.get(name) ?? (folded.get(name.toLowerCase())?.length === 1 ? folded.get(name.toLowerCase())![0] : undefined);
    let label = resolve(raw);
    if (!label && !quoted) { raw = raw.replace(/[.,;:!?)\]}]+$/, ""); label = resolve(raw); }
    if (!label) continue;
    const start = match.index + match[1]!.length;
    result.push({ start, end: start + (quoted ? token.length : raw.length + 1), label });
  }
  return result;
}

/** Remove every occurrence of one selected reference, preserving other text. */
export function removeMention(text: string, label: string, known: string[]): string {
  for (const range of mentionOccurrences(text, known).filter(item => item.label === label).reverse()) {
    const end = text[range.end] === " " ? range.end + 1 : range.end;
    text = text.slice(0, range.start) + text.slice(end);
  }
  return text;
}

export function highlightMentions(text: string, known: string[]): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let last = 0;
  for (const range of mentionOccurrences(text, known)) {
    if (range.start > last) segments.push({ text: text.slice(last, range.start), mention: false });
    segments.push({ text: text.slice(range.start, range.end), mention: true });
    last = range.end;
  }
  if (last < text.length || !segments.length) segments.push({ text: text.slice(last), mention: false });
  return segments;
}
