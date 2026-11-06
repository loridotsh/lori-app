/**
 * A small streaming XML scanner for the big parts of a workbook (sheets, shared strings).
 * It builds no tree, so a very large sheet costs only the cells we keep, and every tag
 * reports its offsets so edits can splice the original text and leave the rest byte-exact.
 *
 * It is deliberately not a general XML parser: no DTDs or custom entities (so nothing can
 * expand), and prefixes are dropped from names.
 */

export interface Tag {
  kind: "open" | "close" | "self";
  /** Local name, without any namespace prefix. */
  name: string;
  attrs: Record<string, string>;
  start: number;
  end: number;
}
export interface Text {
  kind: "text";
  text: string;
  start: number;
  end: number;
}
export type Token = Tag | Text;

const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (_match, body: string) => {
    switch (body) {
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "quot": return '"';
      case "apos": return "'";
    }
    const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TAG_END = /[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/y;

function parseTag(xml: string, start: number): Tag | null {
  TAG_END.lastIndex = start + 1;
  const matched = TAG_END.exec(xml);
  if (!matched) return null;
  const end = start + 1 + matched[0].length;
  const body = matched[0].slice(0, -1);
  if (body[0] === "/") {
    return { kind: "close", name: body.slice(1).trim().replace(/^.*:/, ""), attrs: {}, start, end };
  }
  const selfClosing = body.endsWith("/");
  const inner = selfClosing ? body.slice(0, -1) : body;
  const nameEnd = inner.search(/[\s]/);
  const rawName = nameEnd < 0 ? inner : inner.slice(0, nameEnd);
  const attrs: Record<string, string> = {};
  if (nameEnd >= 0) {
    ATTRIBUTE.lastIndex = 0;
    for (let match = ATTRIBUTE.exec(inner); match; match = ATTRIBUTE.exec(inner)) {
      const key = match[1]!;
      // Keep the prefixed name too, so r:id can be found; the local name is the common lookup.
      const value = decodeEntities(match[2] ?? match[3] ?? "");
      attrs[key] = value;
      const local = key.replace(/^.*:/, "");
      if (local !== key && !(local in attrs)) attrs[local] = value;
    }
  }
  return { kind: selfClosing ? "self" : "open", name: rawName.replace(/^.*:/, ""), attrs, start, end };
}

export class XmlSyntaxError extends Error {}

export function* scan(xml: string): Generator<Token> {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (xml.slice(i).trim()) yield { kind: "text", text: decodeEntities(xml.slice(i)), start: i, end: n };
      return;
    }
    if (lt > i) yield { kind: "text", text: decodeEntities(xml.slice(i, lt)), start: i, end: lt };
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlSyntaxError("Unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlSyntaxError("Unterminated CDATA");
      yield { kind: "text", text: xml.slice(lt + 9, end), start: lt, end: end + 3 };
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlSyntaxError("Unterminated declaration");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) throw new XmlSyntaxError("DTDs are not supported");
    const tag = parseTag(xml, lt);
    if (!tag) throw new XmlSyntaxError("Unterminated tag");
    yield tag;
    i = tag.end;
  }
}
