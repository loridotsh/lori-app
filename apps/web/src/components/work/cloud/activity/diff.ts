export type DiffLine = {
  type: "same" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
};

/** Beyond this many line comparisons a precise diff is not worth the time. */
const MAX_CELLS = 2_000_000;
const MAX_LINES = 2_000;

/**
 * Line diff of two texts by longest common subsequence. Used for the small
 * snippets an edit replaces; very large inputs fall back to "all removed, then
 * all added" rather than stalling the page.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES || a.length * b.length > MAX_CELLS) {
    // Every line is kept: a reviewer approving a large write must be able to page through all of it.
    return [
      ...a.map((text, i): DiffLine => ({ type: "del", text, oldLine: i + 1 })),
      ...b.map((text, i): DiffLine => ({ type: "add", text, newLine: i + 1 })),
    ];
  }
  // lengths[i][j] = longest common subsequence of a[i..] and b[j..]
  const lengths: Uint32Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i]![j] =
        a[i] === b[j]
          ? lengths[i + 1]![j + 1]! + 1
          : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ type: "same", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      result.push({ type: "del", text: a[i]!, oldLine: i + 1 });
      i++;
    } else {
      result.push({ type: "add", text: b[j]!, newLine: j + 1 });
      j++;
    }
  }
  for (; i < a.length; i++) result.push({ type: "del", text: a[i]!, oldLine: i + 1 });
  for (; j < b.length; j++) result.push({ type: "add", text: b[j]!, newLine: j + 1 });
  return result;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added++;
    else if (line.type === "del") removed++;
  }
  return { added, removed };
}
