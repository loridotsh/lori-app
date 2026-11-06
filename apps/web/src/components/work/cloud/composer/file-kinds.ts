import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoCameraIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";

export type FileKind =
  | "image"
  | "video"
  | "pdf"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "code"
  | "text"
  | "archive"
  | "other";

/** The server's per-file limit (20 MiB); checked here first so a drop fails fast. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Files accepted from one drop, paste or picker, so a stray folder-sized selection cannot flood a conversation. */
export const MAX_BATCH_FILES = 10;
const MAX_NAME = 200;

const EXTENSIONS: Record<string, FileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", bmp: "image", heic: "image",
  mp4: "video", webm: "video", mov: "video",
  pdf: "pdf",
  xlsx: "spreadsheet", xls: "spreadsheet", csv: "spreadsheet", tsv: "spreadsheet", ods: "spreadsheet",
  docx: "document", doc: "document", odt: "document", rtf: "document",
  pptx: "presentation", ppt: "presentation", odp: "presentation", key: "presentation",
  js: "code", jsx: "code", ts: "code", tsx: "code", py: "code", rb: "code", go: "code", rs: "code",
  java: "code", c: "code", h: "code", cpp: "code", cs: "code", php: "code", sh: "code", sql: "code",
  html: "code", css: "code", json: "code", yaml: "code", yml: "code", toml: "code", xml: "code",
  md: "text", markdown: "text", txt: "text", log: "text",
  zip: "archive", gz: "archive", tar: "archive", tgz: "archive", "7z": "archive", rar: "archive",
};

export function fileKind(path: string, mimeType = ""): FileKind {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (Object.hasOwn(EXTENSIONS, extension)) return EXTENSIONS[extension]!;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/")) return "text";
  return "other";
}

const ICONS: Record<FileKind, LucideIcon> = {
  image: FileImageIcon,
  video: FileVideoCameraIcon,
  pdf: FileTextIcon,
  spreadsheet: FileSpreadsheetIcon,
  document: FileTextIcon,
  presentation: PresentationIcon,
  code: FileCodeIcon,
  text: FileTextIcon,
  archive: FileArchiveIcon,
  other: FileIcon,
};
export const fileIcon = (kind: FileKind): LucideIcon => ICONS[kind];

/** A path-safe upload name: no separators or control characters, bounded, extension kept. */
export function uploadName(raw: string, fallback = "file"): string {
  const cleaned = raw.replace(/[\\/\u0000-\u001f\u007f]+/g, "_").replace(/^\.+/, "").trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= MAX_NAME) return cleaned.normalize("NFC");
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return (cleaned.slice(0, MAX_NAME - extension.length) + extension).normalize("NFC");
}

const pad = (value: number) => String(value).padStart(2, "0");
/** Clipboard images arrive as a bare "image.png"; give them a name that sorts and means something. */
export function pastedName(file: { name: string; type: string }, now = new Date()): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file.name;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  return `pasted-image-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${extension}`;
}

/** The content type to declare, or nothing when the browser's value is not a valid media type. */
export function declaredMimeType(type: string): string | undefined {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i.test(type)
    ? type
    : undefined;
}

export interface PreparedUpload {
  file: File;
  name: string;
  mimeType?: string;
}
export interface RejectedUpload {
  name: string;
  reason: string;
}

/**
 * Decides which of a set of dropped, pasted or picked files to upload. Never
 * throws: every file is either prepared or rejected with a reason to show.
 */
export function prepareUploads(
  files: File[],
  options: { existing?: string[]; paste?: boolean; now?: Date } = {},
): { accepted: PreparedUpload[]; rejected: RejectedUpload[] } {
  const accepted: PreparedUpload[] = [];
  const rejected: RejectedUpload[] = [];
  const taken = new Set((options.existing ?? []).map((name) => name.toLowerCase()));
  for (const file of files) {
    const shown = file.name || "Unnamed file";
    if (accepted.length >= MAX_BATCH_FILES) {
      rejected.push({ name: shown, reason: `Only ${MAX_BATCH_FILES} files can be added at once` });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name: shown, reason: "is empty" });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({ name: shown, reason: "is larger than 20 MB" });
      continue;
    }
    let name = uploadName(options.paste ? pastedName(file, options.now) : file.name);
    // Two files with one name would overwrite each other; keep both.
    if (taken.has(name.toLowerCase())) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (taken.has(`${stem} (${n})${extension}`.toLowerCase())) n++;
      name = `${stem} (${n})${extension}`;
    }
    taken.add(name.toLowerCase());
    const mimeType = declaredMimeType(file.type);
    accepted.push({ file, name, ...(mimeType ? { mimeType } : {}) });
  }
  return { accepted, rejected };
}

/** "notes.pdf is empty. big.zip is larger than 20 MB." */
export function describeRejections(rejected: RejectedUpload[]): string {
  if (!rejected.length) return "";
  const shown = rejected.slice(0, 3).map((item) => `${item.name} ${item.reason}`);
  const more = rejected.length - shown.length;
  return `${shown.join(". ")}${more > 0 ? `, and ${more} more` : ""}.`.replace(/\.\./g, ".");
}
