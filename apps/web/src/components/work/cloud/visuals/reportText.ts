export type ReportPart =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbered"; items: string[]; start: number };

const bullet = /^\s*[-•*]\s+/;
const numbered = /^\s*(\d{1,3})[.)]\s+/;

export function reportParts(body: string): ReportPart[] {
  const parts: ReportPart[] = [];
  for (const chunk of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = chunk.split("\n").map(line => line.trimEnd()).filter(line => line.trim());
    let index = 0;
    while (index < lines.length) {
      const line = lines[index]!;
      if (bullet.test(line)) {
        const items: string[] = [];
        while (index < lines.length && bullet.test(lines[index]!)) items.push(lines[index++]!.replace(bullet, ""));
        parts.push({ kind: "bullets", items });
      } else if (numbered.test(line)) {
        const start = Number(numbered.exec(line)![1]);
        const items: string[] = [];
        while (index < lines.length && numbered.test(lines[index]!)) items.push(lines[index++]!.replace(numbered, ""));
        parts.push({ kind: "numbered", items, start });
      } else {
        const paragraph: string[] = [];
        while (index < lines.length && !bullet.test(lines[index]!) && !numbered.test(lines[index]!)) paragraph.push(lines[index++]!.trim());
        parts.push({ kind: "paragraph", lines: paragraph });
      }
    }
  }
  return parts;
}

export function emphasis(text: string): { text: string; strong: boolean }[] {
  const pieces: { text: string; strong: boolean }[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) pieces.push({ text: text.slice(last, match.index), strong: false });
    pieces.push({ text: match[1]!, strong: true });
    last = match.index! + match[0].length;
  }
  if (last < text.length) pieces.push({ text: text.slice(last), strong: false });
  return pieces;
}
