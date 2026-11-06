import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { CloudFile, PersonalProjectContextReference, PersonalProjectReference } from "@lori-enterprise/contracts";
import { IdentityError } from "../../auth/identity-service.js";
import { recordAuditEvent } from "../../auth/audit.js";
import { bytesHash } from "../files.js";
import { prepare } from "../preview-queue.js";
import type { CloudActor, CloudWorkService } from "../service.js";
import type { CloudPersonalProjects } from "./service.js";

/** The limits a conversation's workspace has: 20 MiB per file, 100 MiB and 100 files in all. */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_REFERENCES = 100;
/** Older versions are pruned beyond this many; they exist so an in-flight chat can finish on the version it began with. */
export const RETAINED_REFERENCE_VERSIONS = 10;

interface ReferenceRow {
  id: string;
  personal_project_id: string;
  organization_id: string;
  member_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const missing = () => new IdentityError(404, "personal_project_reference_not_found", "Reference file was not found.");
const conflict = () => new IdentityError(409, "personal_project_reference_conflict", "The reference changed. Reload it before trying again.");

export function referenceName(value: string): string {
  const name = value.normalize("NFC").trim();
  if (!name || name.length > 200 || name === "." || name === ".." || name.startsWith(".lori-") || /[\\/\u0000-\u001f\u007f]/.test(name))
    throw new IdentityError(400, "personal_project_reference_name_invalid", "Choose a file name without folders or control characters, up to 200 characters.");
  return name;
}

export function referenceView(row: ReferenceRow): PersonalProjectReference {
  return {
    id: row.id,
    projectId: row.personal_project_id,
    name: row.name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The shape the page-preview pipeline works with; a reference has no conversation, so the project id stands in. */
export function previewSubject(reference: PersonalProjectReference): CloudFile {
  return {
    id: reference.id,
    conversationId: reference.projectId,
    path: reference.name,
    mimeType: reference.mimeType,
    sizeBytes: reference.sizeBytes,
    sha256: reference.sha256,
    version: reference.version,
    createdAt: reference.createdAt,
    updatedAt: reference.updatedAt,
  };
}

/**
 * Project-level knowledge. A chat reads a reference through its id and never
 * writes to it: the working files of a conversation live in a different table,
 * so no file tool, apply step or command can reach these rows.
 */
export class PersonalProjectReferences {
  constructor(private cloud: CloudWorkService, private projects: CloudPersonalProjects) {}

  private async enabled(c: PoolClient, a: CloudActor) {
    await this.cloud.ensure(c, a, true);
    await this.projects.authorization.bind(c, a);
  }

  async rowTx(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">, id: string, lock = false): Promise<ReferenceRow> {
    await this.projects.authorization.bind(c, a);
    const row = (
      await c.query<ReferenceRow>(
        `SELECT r.* FROM cloud_work_personal_project_references r JOIN cloud_work_personal_projects p ON p.id=r.personal_project_id
         WHERE r.id=$1 AND r.organization_id=$2 AND r.member_id=$3 AND p.status<>'deleted' ${lock ? "FOR UPDATE OF r" : ""}`,
        [id, a.organizationId, a.memberId],
      )
    ).rows[0];
    if (!row) throw missing();
    return row;
  }
  async referenceTx(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">, id: string, lock = false) {
    return referenceView(await this.rowTx(c, a, id, lock));
  }

  async listTx(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">, projectId: string): Promise<PersonalProjectReference[]> {
    const rows = await c.query<ReferenceRow>(
      "SELECT * FROM cloud_work_personal_project_references WHERE personal_project_id=$1 AND organization_id=$2 AND member_id=$3 ORDER BY lower(name),id LIMIT $4",
      [projectId, a.organizationId, a.memberId, MAX_REFERENCES],
    );
    return rows.rows.map(referenceView);
  }

  async list(a: CloudActor, projectId: string) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      await this.projects.authorization.own(c, a, projectId);
      return { references: await this.listTx(c, a, projectId) };
    });
  }

  /** The manifest a chat is told about: ids, names and hashes, never content. */
  async manifestTx(c: PoolClient, a: Pick<CloudActor, "organizationId" | "memberId">, projectId: string): Promise<PersonalProjectContextReference[]> {
    return (await this.listTx(c, a, projectId)).map(({ id, name, mimeType, sizeBytes, sha256, version }) => ({ id, name, mimeType, sizeBytes, sha256, version }));
  }

  async get(a: CloudActor, id: string) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.referenceTx(c, a, id);
    });
  }

  /** Hash-verified bytes of the reference's current version. */
  async bytesTx(c: PoolClient, reference: PersonalProjectReference): Promise<Buffer> {
    const version = (
      await c.query<{ storage_key: string }>("SELECT storage_key FROM cloud_work_personal_project_reference_versions WHERE reference_id=$1 AND version=$2", [reference.id, reference.version])
    ).rows[0];
    if (!version) throw new IdentityError(503, "cloud_file_storage_unavailable", "Reference file is unavailable.");
    const data = await this.cloud.files.stagedBytes(version.storage_key);
    if (bytesHash(data) !== reference.sha256) throw new IdentityError(503, "cloud_file_storage_unavailable", "Reference file integrity check failed.");
    return data;
  }

  async download(a: CloudActor, id: string) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      const reference = await this.referenceTx(c, a, id);
      return { reference, bytes: await this.bytesTx(c, reference) };
    });
  }

  async text(a: CloudActor, id: string, startLine: number, limit: number, offset: number) {
    const { reference, bytes } = await this.download(a, id);
    const preview = this.cloud.files.preview(previewSubject(reference), bytes, startLine, limit, offset);
    return { reference, text: preview.text, truncated: preview.truncated, nextOffset: preview.nextOffset };
  }

  private async quota(c: PoolClient, projectId: string) {
    const row = (
      await c.query<{ n: string; size: string }>(
        "SELECT (SELECT count(*) FROM cloud_work_personal_project_references WHERE personal_project_id=$1) AS n, (SELECT COALESCE(sum(size_bytes),0) FROM cloud_work_personal_project_reference_versions WHERE personal_project_id=$1) AS size",
        [projectId],
      )
    ).rows[0]!;
    return { count: Number(row.n), bytes: Number(row.size) };
  }

  private async write(
    c: PoolClient,
    a: CloudActor,
    projectId: string,
    existing: ReferenceRow | undefined,
    name: string,
    mime: string,
    bytes: Buffer,
  ): Promise<PersonalProjectReference> {
    if (bytes.length > MAX_REFERENCE_BYTES) throw new IdentityError(413, "cloud_file_too_large", "Reference files are limited to 20 MiB.");
    const quota = await this.quota(c, projectId);
    if ((!existing && quota.count >= MAX_REFERENCES) || quota.bytes + bytes.length > MAX_REFERENCE_TOTAL_BYTES)
      throw new IdentityError(413, "personal_project_reference_quota", "This project reached its reference limit of 100 files and 100 MiB, counting retained versions.");
    const staged = await this.cloud.files.stage(bytes);
    try {
      const id = existing?.id ?? randomUUID();
      const version = existing ? existing.version + 1 : 1;
      if (version > 1000) throw new IdentityError(413, "cloud_file_version_limit", "This reference reached its version limit. Remove it and upload it again.");
      const row = existing
        ? (
            await c.query<ReferenceRow>(
              "UPDATE cloud_work_personal_project_references SET version=$2,sha256=$3,size_bytes=$4,mime_type=$5,updated_at=NOW() WHERE id=$1 RETURNING *",
              [id, version, staged.hash, bytes.length, mime],
            )
          ).rows[0]!
        : (
            await c.query<ReferenceRow>(
              "INSERT INTO cloud_work_personal_project_references(id,personal_project_id,organization_id,member_id,name,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
              [id, projectId, a.organizationId, a.memberId, name, mime, bytes.length, staged.hash],
            )
          ).rows[0]!;
      await c.query(
        "INSERT INTO cloud_work_personal_project_reference_versions(reference_id,personal_project_id,organization_id,member_id,version,storage_key,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, projectId, a.organizationId, a.memberId, version, staged.key, bytes.length, staged.hash],
      );
      await c.query("DELETE FROM cloud_work_personal_project_reference_versions WHERE reference_id=$1 AND version<=$2", [id, version - RETAINED_REFERENCE_VERSIONS]);
      // A new version retires the old version's rendered pages; the first pages of the new one start rendering now.
      if (existing) await c.query("DELETE FROM cloud_work_file_previews WHERE file_id=$1 AND sha256<>$2", [id, staged.hash]);
      await prepare(c, { id, version, sha256: staged.hash, path: name }, {});
      await c.query("UPDATE cloud_work_personal_projects SET updated_at=NOW() WHERE id=$1", [projectId]);
      return referenceView(row);
    } catch (error) {
      await this.cloud.files.discard(staged.key);
      throw error;
    }
  }

  async upload(a: CloudActor, projectId: string, input: { name: string; mimeType: string; bytes: Buffer; requestId: string }) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      const name = referenceName(input.name);
      return this.projects.idempotent(c, a, input.requestId, "reference", { op: "upload", projectId, name, mime: input.mimeType, hash: bytesHash(input.bytes) }, async () => {
        const project = await this.projects.authorization.own(c, a, projectId, { lock: "update" });
        this.projects.authorization.requireActive(project);
        const taken = await c.query("SELECT 1 FROM cloud_work_personal_project_references WHERE personal_project_id=$1 AND lower(name)=lower($2)", [projectId, name]);
        if (taken.rowCount) throw new IdentityError(409, "personal_project_reference_exists", "A reference with this name already exists. Replace it instead.");
        const reference = await this.write(c, a, projectId, undefined, name, input.mimeType, input.bytes);
        await recordAuditEvent(c, { action: "work.personal_project.reference_added", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "personal_project", subjectId: projectId, metadata: { sizeBytes: reference.sizeBytes } });
        return reference;
      });
    });
  }

  async replace(a: CloudActor, id: string, input: { bytes: Buffer; mimeType?: string; expectedVersion: number; expectedHash: string; requestId: string }) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      return this.projects.idempotent(c, a, input.requestId, "reference", { op: "replace", id, hash: bytesHash(input.bytes), mime: input.mimeType, expectedVersion: input.expectedVersion, expectedHash: input.expectedHash }, async () => {
        const row = await this.rowTx(c, a, id, true);
        const project = await this.projects.authorization.own(c, a, row.personal_project_id, { lock: "update" });
        this.projects.authorization.requireActive(project);
        if (row.version !== input.expectedVersion || row.sha256 !== input.expectedHash) throw conflict();
        const reference = await this.write(c, a, row.personal_project_id, row, row.name, input.mimeType ?? row.mime_type, input.bytes);
        await recordAuditEvent(c, { action: "work.personal_project.reference_replaced", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "personal_project", subjectId: row.personal_project_id, metadata: { version: reference.version } });
        return reference;
      });
    });
  }

  async remove(a: CloudActor, id: string, expectedVersion: number, expectedHash: string) {
    return this.cloud.transaction(async (c) => {
      await this.enabled(c, a);
      const row = await this.rowTx(c, a, id, true);
      const project = await this.projects.authorization.own(c, a, row.personal_project_id, { lock: "update" });
      this.projects.authorization.requireActive(project);
      if (row.version !== expectedVersion || row.sha256 !== expectedHash) throw conflict();
      await c.query("DELETE FROM cloud_work_personal_project_references WHERE id=$1", [id]);
      await c.query("UPDATE cloud_work_personal_projects SET updated_at=NOW() WHERE id=$1", [row.personal_project_id]);
      await recordAuditEvent(c, { action: "work.personal_project.reference_removed", actorUserId: a.userId, organizationId: a.organizationId, subjectType: "personal_project", subjectId: row.personal_project_id });
    });
  }

  /** A reference of the project a chat is filed in, named by id. Anything else is the same 404. */
  async forChatTx(c: PoolClient, who: Pick<CloudActor, "organizationId" | "memberId">, projectId: string, referenceId: string) {
    const row = (
      await c.query<ReferenceRow>(
        "SELECT r.* FROM cloud_work_personal_project_references r JOIN cloud_work_personal_projects p ON p.id=r.personal_project_id WHERE r.id=$1 AND r.personal_project_id=$2 AND r.organization_id=$3 AND r.member_id=$4 AND p.status IN ('active','archived')",
        [referenceId, projectId, who.organizationId, who.memberId],
      )
    ).rows[0];
    if (!row) throw missing();
    return referenceView(row);
  }
}
