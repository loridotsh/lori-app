import type { CloudToolInvocation } from "@lori-enterprise/contracts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

const FILE_TOOLS = new Set(["write_file", "edit_file", "manage_files"]);
/** Tools whose files are for Lori's own review (rendered pages), never a deliverable. */
const REVIEW_TOOLS = new Set(["render_document"]);
/** A folder the model used for scratch work, by its usual names. */
const SCRATCH_FOLDER = /(?:^|\/)(?:\.?tmp|temp|scratch|\.cache|renders?|rendered|screenshots?|thumbnails?|page-?renders?)(?:\/|$)/i;
/** What rendering a page produces: `page-3.png`, `slide_2.jpg`, `preview-1.webp`. */
const RENDERED_PAGE = /(?:^|\/)(?:page|slide|sheet|preview|render|screenshot)[-_ ]?\d+\.(?:png|jpe?g|webp)$/i;

/**
 * Whether a file is scaffolding for checking the work (a screenshot of a page
 * Lori rendered to review its layout) rather than something the member asked for.
 */
export function isReviewArtifact(path: string): boolean {
  return SCRATCH_FOLDER.test(path) || RENDERED_PAGE.test(path);
}

/**
 * The files a run created or changed, in the order it touched them and without
 * repeats. Only calls that completed count: a declined or failed write left
 * nothing behind to open. Files moved to Trash are not listed, and neither are
 * the pictures Lori rendered to check its own work.
 */
export function changedFilePaths(invocations: CloudToolInvocation[]): string[] {
  const paths: string[] = [];
  const add = (path: string) => {
    if (path && !isReviewArtifact(path) && !paths.includes(path)) paths.push(path);
  };
  for (const call of invocations) {
    if (call.status !== "completed" || REVIEW_TOOLS.has(call.name)) continue;
    const output = isRecord(call.output) ? call.output : null;
    if (!output || output.trashed) continue;
    if (FILE_TOOLS.has(call.name)) {
      if (isRecord(output.file)) add(text(output.file.path));
      else if (output.moved) add(text(output.path));
    }
    // Commands and document tools stage their files; once the member approves applying them the call completes.
    if (Array.isArray(output.changedFiles))
      for (const item of output.changedFiles) if (isRecord(item)) add(text(item.path));
  }
  return paths;
}
