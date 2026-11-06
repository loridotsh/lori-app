import { createHash, randomUUID } from "node:crypto";
import { constants, type Dir } from "node:fs";
import { mkdir, open, unlink, lstat, opendir } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { PoolClient } from "pg";
import type { CloudFile } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
import { prepare } from "./preview-queue.js";
import { fingerprint } from "./security.js";
import { projectContext, openText, sealText, openJson, sealJson } from "./projects/content.js";
import { projectPathKey, sealProjectBytes, openProjectBytes } from "./projects/crypto.js";
import type { CloudActor, CloudWorkService } from "./service.js";
const MAX_FILE = 20 * 1024 * 1024,
  MAX_TOTAL = 100 * 1024 * 1024,
  MAX_FILES = 100;
/** A generated clip is already paid for, so it gets more room than an upload. */
export const MAX_GENERATED_FILE = 256 * 1024 * 1024;
const MAX_GENERATED_TOTAL = 2 * 1024 * 1024 * 1024;
/** Most bytes one Range response carries; players ask again for the next window. */
const MAX_RANGE = 4 * 1024 * 1024;

/**
 * The bytes a `Range: bytes=…` header asks for, inclusive and capped, so a paused
 * player never holds a transfer open for a whole file. Null means no usable range
 * was asked for; "unsatisfiable" asks for nothing inside the file.
 */
export function byteWindow(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const last = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (start >= size || start > last) return "unsatisfiable" as const;
  return { start, end: Math.min(last, size - 1, start + MAX_RANGE - 1) };
}
export function virtualPath(value: string): string {
  if (
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.split("/").some((x) => !x || x === "." || x === ".." || x.startsWith(".lori-"))
  )
    throw new IdentityError(
      400,
      "cloud_file_path_invalid",
      "Choose a relative workspace path without parent traversal.",
    );
  return value.normalize("NFC");
}
export function bytesHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Generated outputs have no trusted upload MIME. Recognize bounded signatures;
 * unknown content stays a download, including HTML disguised with a PDF name. */
export function generatedFileMime(path: string, bytes: Buffer): string {
  if (/\.pdf$/i.test(path) && bytes.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";
  if (/\.png$/i.test(path) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  return "application/octet-stream";
}
/**
 * A UTF-8 byte-order mark is invisible in the text a member or the assistant
 * edits (decoding drops it), but spreadsheet apps rely on it. Rewriting a file
 * must not silently remove one the file already had.
 */
export function withOriginalBom(original: Buffer, text: string): Buffer {
  const hadBom =
    original.length >= 3 &&
    original[0] === 0xef &&
    original[1] === 0xbb &&
    original[2] === 0xbf;
  const body = Buffer.from(text);
  return hadBom && !text.startsWith("﻿")
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
    : body;
}

function conflict(): never {
  throw new IdentityError(
    409,
    "cloud_file_conflict",
    "The file changed. Read the current version before editing.",
  );
}
function metadata(r: Record<string, unknown>): CloudFile {
  return {
    ...(r.project_id ? { projectId: String(r.project_id) } : {}),
    id: String(r.id),
    conversationId: String(r.conversation_id),
    path: String(r.path),
    mimeType: String(r.mime_type),
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    version: Number(r.version),
    createdAt: (r.created_at as Date).toISOString(),
    updatedAt: (r.updated_at as Date).toISOString(),
  };
}
export class CloudFiles {
  private metadata(c: PoolClient, r: Record<string, unknown>): CloudFile {
    return metadata({ ...r, path: openText(c, "file", String(r.id), "path", String(r.path)) });
  }
  private rootId(c: PoolClient, conversationId: string) { return projectContext(c)?.projectId ?? conversationId; }
  private async putContent(c: PoolClient, bytes: Buffer, key: string) {
    const scope = projectContext(c);
    await this.put(scope ? Buffer.from(JSON.stringify(sealProjectBytes(scope, "blob", key, "bytes", bytes))) : bytes, key);
  }
  private async contentBytes(c: PoolClient, key: string) {
    const raw = await this.bytes(key), scope = projectContext(c);
    return scope ? openProjectBytes(scope, "blob", key, "bytes", JSON.parse(raw.toString("utf8"))) : raw;
  }
  private root: string;
  private scan: Dir | null = null;
  constructor(private cloud: CloudWorkService) {
    this.root = resolve(
      cloud.config.cloud?.filesDirectory ?? ".data/work-cloud",
    );
  }
  private async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new IdentityError(
        503,
        "cloud_file_storage_unavailable",
        "Cloud file storage is unavailable.",
      );
  }
  private blobPath(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error("Invalid storage key");
    return resolve(this.root, key);
  }
  private async put(bytes: Buffer, key: string) {
    await this.ready();
    const handle = await open(this.blobPath(key), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async bytes(key: string) {
    await this.ready();
    const handle = await open(
      this.blobPath(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > Math.ceil(MAX_GENERATED_FILE * 1.34) + 1024)
        throw new IdentityError(
          503,
          "cloud_file_storage_unavailable",
          "Cloud file is unavailable.",
        );
      const bytes = Buffer.alloc(stat.size);
      let position = 0;
      while (position < bytes.length) {
        const result = await handle.read(
          bytes,
          position,
          bytes.length - position,
          position,
        );
        if (!result.bytesRead) break;
        position += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      const tail = await handle.read(extra, 0, 1, position);
      const after = await handle.stat();
      if (
        position !== stat.size ||
        tail.bytesRead ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new IdentityError(
          503,
          "cloud_file_storage_unavailable",
          "Cloud file changed during the read.",
        );
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async stage(bytes: Buffer, c?: PoolClient) {
    if (bytes.length > MAX_FILE)
      throw new IdentityError(
        413,
        "cloud_file_too_large",
        "Cloud files are limited to 20 MiB.",
      );
    const key = randomUUID();
    if (c) await this.putContent(c, bytes, key); else await this.put(bytes, key);
    return { key, hash: bytesHash(bytes), size: bytes.length };
  }
  async stagedBytes(key: string, c?: PoolClient) {
    return c ? this.contentBytes(c, key) : this.bytes(key);
  }
  /** Removes a blob that never became part of a committed row. */
  async discard(key: string) {
    await unlink(this.blobPath(key)).catch(() => {});
  }
  async listTx(c: PoolClient, conversationId: string): Promise<CloudFile[]> {
    const rows = await c.query(
      "SELECT * FROM cloud_work_files WHERE conversation_id=$1 ORDER BY path LIMIT 100",
      [this.rootId(c, conversationId)],
    );
    return rows.rows.map(row => this.metadata(c, row));
  }
  async list(a: CloudActor, id: string) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      await this.cloud.ownConversation(c, a, id);
      return { files: await this.listTx(c, id) };
    });
  }
  async fileTx(c: PoolClient, a: CloudActor, id: string, lock = false) {
    const projectId = await this.cloud.projects.resource(c, a, "file", id);
    const r = await c.query(
      // A chat filed in a deleted personal project is gone for everyone (fail closed: no visible live project, no file).
      `SELECT f.* FROM cloud_work_files f JOIN cloud_work_conversations conv ON conv.id=f.conversation_id WHERE f.id=$1 AND conv.organization_id=$2 AND (conv.member_id=$3 OR conv.project_id=$4)
         AND (conv.personal_project_id IS NULL OR EXISTS(SELECT 1 FROM cloud_work_personal_projects pp WHERE pp.id=conv.personal_project_id AND pp.organization_id=$2 AND pp.member_id=$3 AND pp.status<>'deleted')) ${lock ? "FOR UPDATE OF f" : ""}`,
      [id, a.organizationId, a.memberId, projectId],
    );
    if (!r.rows[0])
      throw new IdentityError(
        404,
        "cloud_file_not_found",
        "Cloud file was not found.",
      );
    return this.metadata(c, r.rows[0]);
  }
  async readTx(c: PoolClient, file: CloudFile) {
    const version = await c.query<{ storage_key: string }>(
      "SELECT storage_key FROM cloud_work_file_versions WHERE file_id=$1 AND version=$2",
      [file.id, file.version],
    );
    if (!version.rows[0])
      throw new IdentityError(
        503,
        "cloud_file_storage_unavailable",
        "Cloud file is unavailable.",
      );
    const data = await this.contentBytes(c, version.rows[0].storage_key);
    if (bytesHash(data) !== file.sha256)
      throw new IdentityError(
        503,
        "cloud_file_storage_unavailable",
        "Cloud file integrity check failed.",
      );
    return data;
  }
  /** One window of a stored file. Plain blobs are read in place, so seeking a long clip never reloads all of it. */
  private async sliceTx(c: PoolClient, file: CloudFile, start: number, end: number) {
    if (projectContext(c)) return (await this.readTx(c, file)).subarray(start, end + 1);
    const version = await c.query<{ storage_key: string }>(
      "SELECT storage_key FROM cloud_work_file_versions WHERE file_id=$1 AND version=$2",
      [file.id, file.version],
    );
    if (!version.rows[0])
      throw new IdentityError(503, "cloud_file_storage_unavailable", "Cloud file is unavailable.");
    const handle = await open(this.blobPath(version.rows[0].storage_key), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(end - start + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length)
        throw new IdentityError(503, "cloud_file_storage_unavailable", "Cloud file is unavailable.");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  /** What the content route serves: the whole file, or the window a player asked for. */
  async content(a: CloudActor, id: string, exported: boolean, range?: string) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      const file = await this.fileTx(c, a, id);
      if (file.projectId && exported) await this.cloud.projects.authorize(c, a, file.projectId, "export");
      const window = byteWindow(range, file.sizeBytes);
      if (window === "unsatisfiable") return { file, window };
      if (window) return { file, window, bytes: await this.sliceTx(c, file, window.start, window.end) };
      return { file, window, bytes: await this.readTx(c, file) };
    });
  }
  async download(a: CloudActor, id: string, exported = true) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      const file = await this.fileTx(c, a, id);
      if (file.projectId && exported) await this.cloud.projects.authorize(c, a, file.projectId, "export");
      return { file, bytes: await this.readTx(c, file) };
    });
  }
  preview(
    file: CloudFile,
    bytes: Buffer,
    startLine = 1,
    limit = 1000,
    offset = 0,
  ) {
    if (offset < 0 || offset > bytes.length)
      throw new IdentityError(
        400,
        "cloud_file_offset",
        "File offset is outside this file.",
      );
    let text: string;
    try {
      text = this.decode(bytes.subarray(offset));
    } catch (error) {
      if (offset)
        throw new IdentityError(
          400,
          "cloud_file_offset",
          "Use the returned UTF-8 byte cursor for this file.",
        );
      throw error;
    }
    let start = 0;
    for (let line = 1; line < startLine; line++) {
      const next = text.indexOf("\n", start);
      if (next < 0) {
        start = text.length;
        break;
      }
      start = next + 1;
    }
    let end = start;
    for (let line = 0; line < limit; line++) {
      const next = text.indexOf("\n", end);
      if (next < 0) {
        end = text.length;
        break;
      }
      end = next + 1;
    }
    const selected = text.slice(start, end);
    let charEnd = Math.min(selected.length, 262144);
    if (
      charEnd < selected.length &&
      selected.charCodeAt(charEnd - 1) >= 0xd800 &&
      selected.charCodeAt(charEnd - 1) <= 0xdbff
    )
      charEnd--;
    const candidate = Buffer.from(selected.slice(0, charEnd));
    let boundary = Math.min(candidate.length, 262144);
    while (
      boundary > 0 &&
      boundary < candidate.length &&
      (candidate[boundary]! & 0xc0) === 0x80
    )
      boundary--;
    const preview = candidate.subarray(0, boundary).toString("utf8");
    const used = Buffer.byteLength(preview),
      // TextDecoder consumes a leading UTF-8 BOM, including at a byte cursor.
      // Recover those bytes before mapping decoded positions back to the file.
      strippedBytes = bytes.length - offset - Buffer.byteLength(text),
      absolute = offset + strippedBytes + Buffer.byteLength(text.slice(0, start));
    const nextOffset = absolute + used < bytes.length ? absolute + used : null;
    return {
      file,
      text: preview,
      truncated: end < text.length || used < Buffer.byteLength(selected),
      nextOffset,
    };
  }
  async text(
    a: CloudActor,
    id: string,
    startLine = 1,
    limit = 1000,
    offset = 0,
  ) {
    const { file, bytes } = await this.download(a, id, false);
    return this.preview(file, bytes, startLine, limit, offset);
  }
  decode(bytes: Buffer): string {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new IdentityError(
        415,
        "cloud_file_not_text",
        "This file is not UTF-8 text. Use a document tool or download it.",
      );
    }
  }
  async receipt(c: PoolClient, a: CloudActor, requestId: string, fp: string) {
    const r = await c.query<{ fingerprint: string; response: CloudFile }>(
      "SELECT fingerprint,response FROM cloud_work_mutations WHERE organization_id=$1 AND member_id=$2 AND request_id=$3",
      [a.organizationId, a.memberId, requestId],
    );
    if (r.rows[0]) {
      if (r.rows[0].fingerprint !== fp) conflict();
      return openJson(c, "mutation", requestId, "response", r.rows[0].response);
    }
    return null;
  }
  /** Generated files have their own allowance, so a large clip never blocks ordinary files. */
  private async quotaTx(c: PoolClient, conversationId: string) {
    const { rows: [row] } = await c.query<{ n: string; size: string; ordinary: string }>(
      "SELECT count(DISTINCT f.id) AS n,COALESCE(sum(v.size_bytes),0) AS size,COALESCE(sum(v.size_bytes) FILTER (WHERE NOT f.generated),0) AS ordinary FROM cloud_work_files f LEFT JOIN cloud_work_file_versions v ON v.file_id=f.id WHERE f.conversation_id=$1",
      [conversationId],
    );
    return { files: Number(row!.n), total: Number(row!.size), ordinary: Number(row!.ordinary) };
  }
  /** Asked before generating, so a full conversation is never charged for a file it cannot keep. */
  async generatedRoomTx(c: PoolClient, conversationId: string) {
    const quota = await this.quotaTx(c, this.rootId(c, conversationId));
    return quota.files < MAX_FILES && quota.total + MAX_GENERATED_FILE <= MAX_GENERATED_TOTAL;
  }
  async saveTx(
    c: PoolClient,
    a: CloudActor,
    conversationId: string,
    path: string,
    bytes: Buffer,
    mime: string,
    expected?: { version: number; hash: string },
    requestId?: string,
    generated = false,
  ): Promise<CloudFile> {
    path = virtualPath(path);
    if (bytes.length > (generated ? MAX_GENERATED_FILE : MAX_FILE))
      throw new IdentityError(
        413,
        "cloud_file_too_large",
        `Cloud files are limited to ${generated ? 256 : 20} MiB.`,
      );
    await this.cloud.ownConversation(c, a, conversationId, true, "files.write");
    const originalConversationId = conversationId;
    conversationId = this.rootId(c, conversationId);
    // Every shared-file writer holds the same root lock, regardless of chat.
    if (conversationId !== originalConversationId) await this.cloud.ownConversation(c, a, conversationId, true, "files.write");
    const scope = projectContext(c), pathKey = scope ? projectPathKey(scope, path) : null;
    const old = (
      await c.query(
        "SELECT * FROM cloud_work_files WHERE conversation_id=$1 AND (($3::text IS NULL AND path=$2) OR path_key=$3) FOR UPDATE",
        [conversationId, path, pathKey],
      )
    ).rows[0];
    if (old) {
      if (
        !expected ||
        Number(old.version) !== expected.version ||
        String(old.sha256) !== expected.hash
      )
        conflict();
    } else if (expected) conflict();
    // The virtual store must remain representable as a real directory tree.
    // Otherwise independently valid files such as "reports" and "reports/a"
    // make every staged command fail before it can run.
    await this.checkPathTx(c, conversationId, path, old?.id);
    const quota = await this.quotaTx(c, conversationId);
    if (
      (!old && quota.files >= MAX_FILES) ||
      quota.total + bytes.length > MAX_GENERATED_TOTAL ||
      (!generated && quota.ordinary + bytes.length > MAX_TOTAL)
    )
      throw new IdentityError(
        413,
        "cloud_file_quota",
        "This conversation reached its 100 MiB workspace limit.",
      );
    const version = old ? Number(old.version) + 1 : 1;
    if (version > 1000)
      throw new IdentityError(
        413,
        "cloud_file_version_limit",
        "This file reached its version limit. Create a new file.",
      );
    const key = randomUUID(),
      id = old ? String(old.id) : randomUUID(),
      hash = bytesHash(bytes);
    await this.putContent(c, bytes, key);
    try {
      const row = old
        ? (
            await c.query(
              "UPDATE cloud_work_files SET version=$2,sha256=$3,size_bytes=$4,mime_type=$5,updated_at=NOW() WHERE id=$1 RETURNING *",
              [id, version, hash, bytes.length, mime],
            )
          ).rows[0]
        : (
            await c.query(
              "INSERT INTO cloud_work_files(id,conversation_id,path,mime_type,size_bytes,sha256,path_key,path_prefixes,generated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
              [id, conversationId, sealText(c, "file", id, "path", path), mime, bytes.length, hash, pathKey, scope ? this.prefixes(path).map(p => projectPathKey(scope, p)) : null, generated],
            )
          ).rows[0];
      await c.query(
        "INSERT INTO cloud_work_file_versions(file_id,version,storage_key,size_bytes,sha256) VALUES ($1,$2,$3,$4,$5)",
        [id, version, key, bytes.length, hash],
      );
      // A new version retires the old version's rendered pages, and its first pages start rendering now,
      // so by the time the member opens the document they are usually already there.
      if (old) await c.query("DELETE FROM cloud_work_file_previews WHERE file_id=$1 AND sha256<>$2", [id, hash]);
      await prepare(c, { id, version, sha256: hash, path }, {});
      const file = this.metadata(c, row);
      if (scope) await this.cloud.projects.invalidate(c, scope.projectId);
      if (requestId)
        await c.query(
          "INSERT INTO cloud_work_mutations(organization_id,member_id,request_id,fingerprint,response,project_id) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            a.organizationId,
            a.memberId,
            requestId,
            fingerprint({
              op: "upload",
              conversationId: originalConversationId,
              path,
              hash,
              mime,
              expected,
            }),
            JSON.stringify(sealJson(c, "mutation", requestId, "response", file)),
            scope?.projectId ?? null,
          ],
        );
      return file;
    } catch (e) {
      await unlink(this.blobPath(key)).catch(() => {});
      throw e;
    }
  }
  async upload(
    a: CloudActor,
    id: string,
    path: string,
    mime: string,
    bytes: Buffer,
    requestId: string,
  ) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      await this.cloud.ownConversation(c, a, id, true, "files.write");
      const fp = fingerprint({
        op: "upload",
        conversationId: id,
        path: virtualPath(path),
        hash: bytesHash(bytes),
        mime,
        expected: undefined,
      });
      const old = await this.receipt(c, a, requestId, fp);
      if (old) return old;
      return this.saveTx(c, a, id, path, bytes, mime, undefined, requestId);
    });
  }
  async edit(
    a: CloudActor,
    id: string,
    input: {
      text: string;
      expectedVersion: number;
      expectedHash: string;
      requestId: string;
      path?: string;
    },
  ) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      let file = await this.fileTx(c, a, id);
      await this.cloud.ownConversation(c, a, file.conversationId, true, "files.write");
      file = await this.fileTx(c, a, id, true);
      const fp = fingerprint({ op: "edit", id, ...input });
      const receipt = await this.receipt(c, a, input.requestId, fp);
      if (receipt) return receipt;
      if (
        file.version !== input.expectedVersion ||
        file.sha256 !== input.expectedHash
      )
        conflict();
      const destination = input.path === undefined ? file.path : virtualPath(input.path);
      if (destination !== file.path)
        await this.checkPathTx(c, file.conversationId, destination, file.id);
      const result = await this.saveTx(
        c,
        a,
        file.conversationId,
        file.path,
        withOriginalBom(await this.readTx(c, file), input.text),
        file.mimeType,
        { version: file.version, hash: file.sha256 },
      );
      if (destination !== file.path) {
        result.path = destination;
        const scope = projectContext(c);
        await c.query("UPDATE cloud_work_files SET path=$2,path_key=$3,path_prefixes=$4 WHERE id=$1", [
          id,
          sealText(c, "file", id, "path", result.path),
          scope ? projectPathKey(scope, result.path) : null,
          scope ? this.prefixes(result.path).map(p => projectPathKey(scope, p)) : null,
        ]);
      }
      await c.query(
        "INSERT INTO cloud_work_mutations(organization_id,member_id,request_id,fingerprint,response,project_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          a.organizationId,
          a.memberId,
          input.requestId,
          fp,
          JSON.stringify(sealJson(c, "mutation", input.requestId, "response", result)),
          projectContext(c)?.projectId ?? null,
        ],
      );
      return result;
    });
  }
  /**
   * Replaces the bytes of an existing workbook with an edited copy, as a new
   * version of the same file. Only packaged spreadsheets are accepted here
   * (text files have their own edit path), and the content must at least be a
   * zip, so a broken upload cannot silently replace a good file.
   */
  async replaceContent(
    a: CloudActor,
    id: string,
    input: {
      bytes: Buffer;
      expectedVersion: number;
      expectedHash: string;
      requestId: string;
    },
  ) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      let file = await this.fileTx(c, a, id);
      await this.cloud.ownConversation(c, a, file.conversationId, true, "files.write");
      file = await this.fileTx(c, a, id, true);
      const fp = fingerprint({
        op: "replace",
        id,
        hash: bytesHash(input.bytes),
        expectedVersion: input.expectedVersion,
        expectedHash: input.expectedHash,
      });
      const receipt = await this.receipt(c, a, input.requestId, fp);
      if (receipt) return receipt;
      if (!/\.xlsx$/i.test(file.path))
        throw new IdentityError(
          415,
          "cloud_file_not_editable",
          "Only .xlsx workbooks can be saved from the spreadsheet editor.",
        );
      if (
        input.bytes.length < 22 ||
        input.bytes.readUInt32LE(0) !== 0x04034b50
      )
        throw new IdentityError(
          400,
          "cloud_file_not_workbook",
          "The edited workbook is not a valid .xlsx package.",
        );
      if (
        file.version !== input.expectedVersion ||
        file.sha256 !== input.expectedHash
      )
        conflict();
      const result = await this.saveTx(
        c,
        a,
        file.conversationId,
        file.path,
        input.bytes,
        file.mimeType,
        { version: file.version, hash: file.sha256 },
      );
      await c.query(
        "INSERT INTO cloud_work_mutations(organization_id,member_id,request_id,fingerprint,response,project_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          a.organizationId,
          a.memberId,
          input.requestId,
          fp,
          JSON.stringify(sealJson(c, "mutation", input.requestId, "response", result)),
          projectContext(c)?.projectId ?? null,
        ],
      );
      return result;
    });
  }
  private async checkPathTx(c: PoolClient, conversationId: string, path: string, excludeId?: string) {
    // Callers hold the conversation lock so uploads and renames cannot race.
    const scope = projectContext(c);
    const collision = scope ? await c.query(
      "SELECT 1 FROM cloud_work_files WHERE project_id=$1 AND ($3::uuid IS NULL OR id<>$3) AND (path_key=$2 OR $2=ANY(path_prefixes) OR path_key=ANY($4::text[])) LIMIT 1",
      [scope.projectId, projectPathKey(scope, path), excludeId ?? null, this.prefixes(path).map(p => projectPathKey(scope, p))],
    ) : await c.query(
      "SELECT 1 FROM cloud_work_files WHERE conversation_id=$1 AND ($3::uuid IS NULL OR id<>$3) AND (path=$2 OR starts_with(path,$2||'/') OR starts_with($2,path||'/')) LIMIT 1",
      [conversationId, path, excludeId ?? null],
    );
    if (collision.rowCount)
      throw new IdentityError(409, "cloud_file_path_conflict", "A file occupies this path, its parent directory or a child path. Choose another path.");
  }
  private prefixes(path: string) { const parts = path.split("/"); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/")); }
  async moveTx(c: PoolClient, a: CloudActor, file: CloudFile, path: string, trash = false) {
    path = virtualPath(path);
    await this.cloud.ownConversation(c, a, file.conversationId, true, trash ? "files.delete" : "files.write");
    const current = await this.fileTx(c, a, file.id, true);
    if (current.version !== file.version || current.sha256 !== file.sha256) conflict();
    await this.checkPathTx(c, file.conversationId, path, file.id);
    const scope = projectContext(c);
    await c.query("UPDATE cloud_work_files SET path=$2,path_key=$3,path_prefixes=$4,version=version+1,updated_at=NOW() WHERE id=$1", [file.id, sealText(c, "file", file.id, "path", path), scope ? projectPathKey(scope, path) : null, scope ? this.prefixes(path).map(p => projectPathKey(scope, p)) : null]);
    await c.query("UPDATE cloud_work_file_versions SET version=version+1 WHERE file_id=$1 AND version=$2", [file.id, file.version]);
    if (scope) await this.cloud.projects.invalidate(c, scope.projectId);
  }
  async remove(a: CloudActor, id: string, version: number, hash: string) {
    return this.cloud.transaction(async (c) => {
      await this.cloud.ensure(c, a);
      let file = await this.fileTx(c, a, id);
      await this.cloud.ownConversation(c, a, file.conversationId, true, "files.delete");
      file = await this.fileTx(c, a, id, true);
      if (file.version !== version || file.sha256 !== hash) conflict();
      await c.query("DELETE FROM cloud_work_files WHERE id=$1", [id]);
      if (file.projectId) await this.cloud.projects.invalidate(c, file.projectId);
    });
  }
  async attached(
    c: PoolClient,
    a: CloudActor,
    conversationId: string,
    ids: string[],
  ) {
    const files: CloudFile[] = [];
    for (const id of ids) {
      const f = await this.fileTx(c, a, id);
      if (f.conversationId !== this.rootId(c, conversationId))
        throw new IdentityError(
          400,
          "cloud_attachment_scope",
          "Attachments must belong to this conversation.",
        );
      files.push(f);
    }
    return files;
  }
  async cleanup() {
    await this.ready();
    this.scan ??= await opendir(this.root);
    for (let i = 0; i < 100; i++) {
      const entry = await this.scan.read();
      if (!entry) {
        await this.scan.close();
        this.scan = null;
        break;
      }
      if (!/^[0-9a-f-]{36}$/.test(entry.name) || !entry.isFile()) continue;
      const stat = await lstat(this.blobPath(entry.name)).catch(() => null);
      if (!stat || stat.mtimeMs > Date.now() - 10 * 60 * 1000) continue;
      const used = await this.cloud.pool.query(
        "SELECT 1 FROM cloud_work_file_versions WHERE storage_key=$1 UNION ALL SELECT 1 FROM cloud_work_staged_files WHERE storage_key=$1 UNION ALL SELECT 1 FROM cloud_work_project_blob_references WHERE storage_key=$1 UNION ALL SELECT 1 FROM cloud_work_personal_blob_references WHERE storage_key=$1",
        [entry.name],
      );
      if (!used.rowCount)
        await unlink(this.blobPath(entry.name)).catch(() => {});
    }
  }
  async close() {
    await this.scan?.close().catch(() => {});
    this.scan = null;
  }
}
