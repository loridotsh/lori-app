"use client";

import type { CloudFile } from "@lori-enterprise/contracts";
import { useEffect, useMemo, useState } from "react";
import { DocumentPreview } from "./document-preview";
import { QuietStatus } from "./quiet-status";
import { cloudPath } from "@/lib/cloud-work-api";
import { fileIcon, fileKind } from "../composer/file-kinds";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, parseDelimited } from "./csv";
import { imagePreviewUrl } from "./image-preview-url";

export const contentUrl = (id: string, download = false) =>
  `/api${cloudPath}/files/${encodeURIComponent(id)}/content?download=${download ? "true" : "false"}`;

/** Larger images and PDFs are download-only so opening a file never pulls a huge body into memory. */
const MAX_INLINE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};
const extensionOf = (path: string) => (path.split(".").at(-1) ?? "").toLowerCase();

/** The media type an image preview may use, or null when the browser cannot show this file. */
export const imageType = (path: string): string | null =>
  IMAGE_TYPES[extensionOf(path)] ?? null;

export type PreviewMode = "text" | "image" | "video" | "pdf" | "document" | "spreadsheet" | "binary";

const BINARY_KINDS = new Set(["archive", "document", "presentation"]);
const TEXT_SPREADSHEETS = new Set(["csv", "tsv"]);

/** How a file is shown: text it can edit, an image, a PDF link, or a download card. */
export function previewMode(file: Pick<CloudFile, "path" | "mimeType">): PreviewMode {
  const kind = fileKind(file.path, file.mimeType);
  if (kind === "image") return imageType(file.path) ? "image" : "binary";
  if (kind === "video") return "video";
  if (kind === "pdf") return "pdf";
  // Workbooks open as a live sheet (view, edit, recalculate); everything else office-like is page images.
  if (/\.xlsx$/i.test(file.path)) return "spreadsheet";
  if (/\.(docx|pptx|doc|xls|ppt|odt|ods|odp)$/i.test(file.path)) return "document";
  if (kind === "spreadsheet") return TEXT_SPREADSHEETS.has(extensionOf(file.path)) ? "text" : "binary";
  return BINARY_KINDS.has(kind) ? "binary" : "text";
}

/** Fetches the file once and exposes it as an object URL that is released when the file changes. */
function useBlobUrl(file: CloudFile, type: string, enabled: boolean, expectPrefix?: string) {
  const [state, setState] = useState<{ url: string | null; status: "loading" | "ready" | "failed" }>({
    url: null,
    status: "loading",
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ url: null, status: "loading" });
    void (async () => {
      try {
        const response = await fetch(contentUrl(file.id), {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(String(response.status));
        const bytes = await response.arrayBuffer();
        if (
          expectPrefix &&
          new TextDecoder().decode(bytes.slice(0, expectPrefix.length)) !== expectPrefix
        )
          throw new Error("not the expected type");
        objectUrl = await imagePreviewUrl(new Blob([bytes], { type }));
        if (!controller.signal.aborted) setState({ url: objectUrl, status: "ready" });
        else URL.revokeObjectURL(objectUrl);
      } catch {
        if (!controller.signal.aborted) setState({ url: null, status: "failed" });
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, file.sha256, type, enabled, expectPrefix]);
  return state;
}

/** A file this view cannot show: say what it is. The panel's footer carries the Download action. */
export function BinaryCard({ file, note }: { file: CloudFile; note?: string }) {
  const Icon = fileIcon(fileKind(file.path, file.mimeType));
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <Icon aria-hidden className="size-8 text-muted-foreground" />
      <p className="max-w-[28ch] break-all text-sm font-medium">{file.path.split("/").at(-1)}</p>
      <p className="max-w-[34ch] text-xs leading-5 text-muted-foreground">
        {note ?? "This kind of file can't be previewed here. Download it to open it in a matching app, or ask Lori to read it."}
      </p>
    </div>
  );
}

export function ImagePreview({ file }: { file: CloudFile }) {
  const type = imageType(file.path) ?? "image/png";
  const tooLarge = file.sizeBytes > MAX_INLINE_BYTES;
  const { url, status } = useBlobUrl(file, type, !tooLarge);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  if (tooLarge || status === "failed" || broken)
    return (
      <BinaryCard
        file={file}
        note={tooLarge ? "This image is too large to preview here." : "This image couldn't be shown. You can still download it."}
      />
    );
  if (!url) return <QuietStatus>Loading image…</QuietStatus>;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden bg-secondary/40 p-4">
      {/* A private object URL for the member's own file, so next/image has nothing to optimize. */}
      <img
        src={url}
        alt={file.path}
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded-md object-contain"
      />
    </div>
  );
}

/** The player streams from the file route, so a long clip never loads whole into memory. */
export function VideoPreview({ file }: { file: CloudFile }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [file.id, file.sha256]);
  if (broken)
    return <BinaryCard file={file} note="This video couldn't be played here. You can still download it." />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <video
        key={file.sha256}
        src={contentUrl(file.id)}
        controls
        playsInline
        preload="metadata"
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded-md"
      />
    </div>
  );
}

/** An image or video a media model made, shown where the reply mentions it. */
export function GeneratedMedia({
  file,
  canDownload,
  onOpen,
}: {
  file: CloudFile;
  canDownload: boolean;
  onOpen: () => void;
}) {
  const name = file.path.split("/").at(-1)!;
  const action = "rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [file.sha256]);
  return (
    <div className="max-w-xl overflow-hidden rounded-xl border border-border bg-secondary/40">
      {broken ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          This preview couldn&apos;t be shown. Open the file to try again.
        </p>
      ) : previewMode(file) === "video" ? (
        <video
          key={file.sha256}
          src={contentUrl(file.id)}
          controls
          playsInline
          preload="metadata"
          onError={() => setBroken(true)}
          className="block max-h-[60dvh] w-full bg-black"
        />
      ) : (
        <button type="button" onClick={onOpen} aria-label={`Open ${name}`} className="block w-full outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {/* A private file behind the session cookie, so next/image has nothing to optimize. */}
          <img src={contentUrl(file.id)} alt={name} loading="lazy" onError={() => setBroken(true)} className="block max-h-[60dvh] w-full object-contain" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
        {canDownload && <a href={contentUrl(file.id, true)} download={name} className={action}>Download</a>}
        <button type="button" onClick={onOpen} className={action}>Open</button>
      </div>
    </div>
  );
}

export function PdfPreview({ file, onStale }: { file: CloudFile; onStale?: () => void }) {
  return <DocumentPreview key={`${file.id}:${file.sha256}`} file={file} onStale={onStale} />;
}

/** Read-only grid for CSV and TSV, capped so a large export stays fast. */
export function TablePreview({ text, delimiter }: { text: string; delimiter: string }) {
  const table = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  if (!table.rows.length)
    return <p className="p-4 text-xs text-muted-foreground">This file has no rows.</p>;
  const [head = [], ...body] = table.rows;
  return (
    <div tabIndex={0} role="region" aria-label="Table content" className="min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <table className="w-max min-w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-secondary">
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col" className="max-w-[24ch] truncate border-b border-border px-3 py-2 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-border/60 last:border-0">
              {row.map((cell, index) => (
                <td key={index} className="max-w-[24ch] truncate px-3 py-1.5" title={cell}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.clipped && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Showing the first {MAX_TABLE_ROWS} rows and {MAX_TABLE_COLUMNS} columns. Download the file for the rest.
        </p>
      )}
    </div>
  );
}
