import { isArtifactFile, MAX_ARTIFACT_FILE_BYTES, type CloudFile } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";

type Page = { file: CloudFile; text: string; truncated: boolean; nextOffset?: number | null };

/** An artifact must be complete and from one revision before it can be rendered or edited. */
export async function loadFileText(file: CloudFile, isCurrent: () => boolean): Promise<Page | null> {
  let page = await cloudApi<Page>(`/files/${encodeURIComponent(file.id)}/text?startLine=1&limit=1000`);
  if (!isCurrent()) return null;
  if (!isArtifactFile(file.path) || file.sizeBytes > MAX_ARTIFACT_FILE_BYTES) return page;
  let text = "", offset = 0;
  const encoder = new TextEncoder();
  for (let count = 0; count < 100; count++) {
    if (page.file.id !== file.id || page.file.version !== file.version || page.file.sha256 !== file.sha256)
      throw new Error("This artifact changed while loading. Reopen its current version from Files.");
    text += page.text;
    if (text.length > MAX_ARTIFACT_FILE_BYTES || encoder.encode(text).length > MAX_ARTIFACT_FILE_BYTES)
      throw new Error("This artifact exceeds the preview limits. Download it to inspect the complete file.");
    if (!page.truncated && page.nextOffset == null) return { ...page, text, truncated: false };
    const next = page.nextOffset;
    if (!Number.isSafeInteger(next) || next! <= offset || next! > MAX_ARTIFACT_FILE_BYTES)
      throw new Error("The artifact could not be read completely. Reopen it to try again.");
    offset = next!;
    page = await cloudApi<Page>(`/files/${encodeURIComponent(file.id)}/text?offset=${offset}&limit=1000`);
    if (!isCurrent()) return null;
  }
  throw new Error("The artifact could not be read completely. Reopen it to try again.");
}
