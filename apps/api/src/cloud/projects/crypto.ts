import { createCipheriv, createDecipheriv, randomBytes, createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { z } from "zod";
import { IdentityError } from "../../auth/identity-service.js";

const Keyring = z.object({ active: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), keys: z.record(z.string(), z.string()) }).strict();
export interface ProjectKey { organizationId: string; projectId: string; key: Buffer }
export interface SealedContent { $project: 1; key: string; nonce: string; tag: string; data: string }
const Envelope = z.object({ $project: z.literal(1), key: z.string(), nonce: z.string(), tag: z.string(), data: z.string() }).strict();
const failure = () => new IdentityError(503, "project_content_unavailable", "Project content is unavailable. Contact your administrator.");

function seal(key: Buffer, keyId: string, aad: string, bytes: Buffer): SealedContent {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { $project: 1, key: keyId, nonce: nonce.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), data: data.toString("base64url") };
}
function open(key: Buffer, aad: string, value: unknown): Buffer {
  try {
    const e = Envelope.parse(value), nonce = Buffer.from(e.nonce, "base64url"), tag = Buffer.from(e.tag, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw failure();
    const cipher = createDecipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(Buffer.from(e.data, "base64url")), cipher.final()]);
  } catch { throw failure(); }
}
export class ProjectKeyring {
  private readonly keys = new Map<string, Buffer>();
  readonly active: string;
  constructor(value: unknown) {
    const parsed = Keyring.parse(value); this.active = parsed.active;
    for (const [id, raw] of Object.entries(parsed.keys)) {
      const bytes = Buffer.from(raw, "base64url");
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || bytes.length !== 32 || bytes.toString("base64url") !== raw) throw failure();
      this.keys.set(id, bytes);
    }
    if (!this.keys.has(this.active)) throw failure();
  }
  static fromFile(path: string): ProjectKeyring {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o007) !== 0 || stat.size > 65536) throw failure();
    return new ProjectKeyring(JSON.parse(readFileSync(path, "utf8")));
  }
  create(organizationId: string, projectId: string) {
    const context = { organizationId, projectId, key: randomBytes(32) };
    return { context, wrapped: this.wrap(context) };
  }
  wrap(context: ProjectKey) {
    return seal(this.keys.get(this.active)!, this.active, JSON.stringify(["lori-project-key", 1, context.organizationId, context.projectId]), context.key);
  }
  unwrap(organizationId: string, projectId: string, value: unknown): ProjectKey {
    const e = Envelope.parse(value), key = this.keys.get(e.key);
    if (!key) throw failure();
    const bytes = open(key, JSON.stringify(["lori-project-key", 1, organizationId, projectId]), e);
    if (bytes.length !== 32) throw failure();
    return { organizationId, projectId, key: bytes };
  }
}
function aad(context: ProjectKey, entity: string, id: string, field: string) {
  return JSON.stringify(["lori-project-content", 1, context.organizationId, context.projectId, entity, id, field]);
}
export function sealProjectBytes(context: ProjectKey, entity: string, id: string, field: string, bytes: Buffer) {
  return seal(context.key, context.projectId, aad(context, entity, id, field), bytes);
}
export function openProjectBytes(context: ProjectKey, entity: string, id: string, field: string, value: unknown) {
  if (Envelope.parse(value).key !== context.projectId) throw failure();
  return open(context.key, aad(context, entity, id, field), value);
}
export function sealProjectValue(context: ProjectKey, entity: string, id: string, field: string, value: unknown) {
  return sealProjectBytes(context, entity, id, field, Buffer.from(JSON.stringify(value)));
}
export function openProjectValue<T>(context: ProjectKey, entity: string, id: string, field: string, value: unknown): T {
  try { return JSON.parse(openProjectBytes(context, entity, id, field, value).toString("utf8")) as T; } catch { throw failure(); }
}
/** Only an equality key; filenames and contents are never stored in this digest. */
export function projectPathKey(context: ProjectKey, path: string): string {
  return createHmac("sha256", context.key).update(JSON.stringify(["path", context.organizationId, context.projectId, path])).digest("hex");
}
