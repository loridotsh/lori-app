/**
 * Every command runs in a fresh sandbox that holds only the files it lists in
 * `inputPaths`. Models forget that: they create `report.docx` in one step and
 * open it in the next without listing it, and the command fails with "file not
 * found" for a file that is sitting in the workspace. Instead of expecting
 * perfect recall, a command that names a workspace file outright gets that
 * file staged, and a command that still fails on one is told exactly why.
 */

export interface WorkspaceFile {
  path: string;
  sizeBytes: number;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Not part of a longer path or file name on either side. */
const BEFORE = String.raw`(?<![A-Za-z0-9_.\-/])`;
const AFTER = String.raw`(?![A-Za-z0-9_\-/]|\.[A-Za-z0-9])`;

/** Files in the conversation the command text names in full (`./` prefixes ignored), that are not already declared. */
export function mentionedInputs(
  command: string,
  files: readonly WorkspaceFile[],
  declared: readonly string[],
  limits: { maxInputs: number; maxBytes: number } = { maxInputs: 100, maxBytes: 64 * 1024 * 1024 },
): string[] {
  const text = command.replace(/(?<![A-Za-z0-9_.\-/])\.\//g, "");
  const have = new Set(declared);
  let bytes = declared.reduce(
    (sum, path) => sum + (files.find((file) => file.path === path)?.sizeBytes ?? 0),
    0,
  );
  const added: string[] = [];
  // Longest first, so "reports/q3.docx" is chosen before a shorter file it contains.
  for (const file of [...files].sort((a, b) => b.path.length - a.path.length)) {
    if (have.has(file.path) || file.path.startsWith(".trash/")) continue;
    if (declared.length + added.length >= limits.maxInputs) break;
    if (bytes + file.sizeBytes > limits.maxBytes) continue;
    if (!new RegExp(BEFORE + escape(file.path) + AFTER).test(text)) continue;
    added.push(file.path);
    have.add(file.path);
    bytes += file.sizeBytes;
  }
  return added;
}

const MISSING_FILE = [
  /No such file or directory: ['"]([^'"]+)['"]/g,
  /Package not found at ['"]([^'"]+)['"]/g,
  /FileNotFoundError[^\n]*?['"]([^'"]+)['"]/g,
  /cannot (?:open|access|stat) ['"]?([^'":\n]+?)['"]?: No such file/g,
  /can't open file ['"]([^'"]+)['"]/g,
];

const READ_ONLY_PATH = /Read-only file system|\[Errno 30\]/;

/** Models reach for /tmp by habit; the sandbox refuses it, so say what to use instead. */
export function readOnlyPathHint(stderr: string): string | undefined {
  return READ_ONLY_PATH.test(stderr)
    ? "This sandbox can only write to the working directory and $TMPDIR. /tmp and every other absolute path are read-only. Run the command again with deliverables at a relative path and scratch files under $TMPDIR."
    : undefined;
}

/** A short, actionable explanation when a failed command could not find a file it needed. */
export function missingFileHint(
  stderr: string,
  files: readonly WorkspaceFile[],
  staged: readonly string[],
): string | undefined {
  const missing = new Set<string>();
  for (const pattern of MISSING_FILE)
    for (const match of stderr.matchAll(pattern))
      missing.add(match[1]!.trim().replace(/^\.\//, ""));
  const notStaged = [...missing].filter(
    (path) => files.some((file) => file.path === path) && !staged.includes(path),
  );
  if (notStaged.length)
    return `${notStaged.map((path) => JSON.stringify(path)).join(", ")} ${notStaged.length === 1 ? "is" : "are"} in this conversation but was not listed in inputPaths, so the sandbox did not contain ${notStaged.length === 1 ? "it" : "them"}. Every command starts fresh: list each existing file it reads in inputPaths and run it again.`;
  const absent = [...missing].filter(
    (path) => !files.some((file) => file.path === path),
  );
  return absent.length
    ? `${absent.map((path) => JSON.stringify(path)).join(", ")} ${absent.length === 1 ? "is" : "are"} not a file in this conversation. A file a command creates exists only after the member applies it, and only the next command that lists it in inputPaths can read it.`
    : undefined;
}
