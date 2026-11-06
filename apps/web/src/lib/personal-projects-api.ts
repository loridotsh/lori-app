import type {
  CloudConversation,
  PersonalProject,
  PersonalProjectCapabilities,
  PersonalProjectCreationPolicy,
  PersonalProjectDetail,
  PersonalProjectReference,
  PersonalProjectStatus,
} from "@lori-enterprise/contracts";
import { ClientApiError } from "./client-api";
import { cloudApi, cloudMutation } from "./cloud-work-api";

export const personalPath = "/personal-projects";
const unreadable = () =>
  new ClientApiError("invalid_response", "Personal projects returned an unreadable response. Update Enterprise or try loading again.", 502);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function validatePersonalProject<T extends PersonalProject>(value: unknown): T {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !["active", "archived", "deleted"].includes(String(value.status)) ||
    !Number.isSafeInteger(value.revision) ||
    !Number.isSafeInteger(value.conversationCount) ||
    !Number.isSafeInteger(value.referenceCount)
  )
    throw unreadable();
  return value as unknown as T;
}
export function validatePersonalCapabilities(value: unknown): PersonalProjectCapabilities {
  if (!object(value) || value.version !== 1 || typeof value.available !== "boolean" || typeof value.canCreate !== "boolean" || typeof value.canAdminister !== "boolean" || !Number.isSafeInteger(value.limit) || !Number.isSafeInteger(value.count))
    throw unreadable();
  return value as unknown as PersonalProjectCapabilities;
}
export function validateReference(value: unknown): PersonalProjectReference {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.sha256 !== "string" || !Number.isSafeInteger(value.sizeBytes) || !Number.isSafeInteger(value.version))
    throw unreadable();
  return value as unknown as PersonalProjectReference;
}

export async function listPersonalProjects(status: PersonalProjectStatus = "active", signal?: AbortSignal): Promise<PersonalProject[]> {
  const all: PersonalProject[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ status, limit: "50" });
    if (cursor) query.set("cursor", cursor);
    const page: { projects: unknown[]; nextCursor: string | null } = await cloudApi(`${personalPath}?${query}`, { signal });
    if (!Array.isArray(page?.projects)) throw unreadable();
    all.push(...page.projects.map((item) => validatePersonalProject<PersonalProject>(item)));
    cursor = page.nextCursor ?? null;
  } while (cursor && all.length < 1000);
  return all;
}
export const getPersonalCapabilities = async (signal?: AbortSignal) =>
  validatePersonalCapabilities(await cloudApi(`${personalPath}/capabilities`, { signal }));
export const getPersonalProject = async (id: string, signal?: AbortSignal) =>
  validatePersonalProject<PersonalProjectDetail>(await cloudApi(`${personalPath}/${encodeURIComponent(id)}`, { signal }));
export const createPersonalProject = async (input: { requestId: string; name: string; description?: string; instructions?: string }) =>
  validatePersonalProject<PersonalProjectDetail>(await cloudApi(personalPath, cloudMutation(input)));
export const updatePersonalProject = async (id: string, input: { expectedRevision: number; name?: string; description?: string; instructions?: string }) =>
  validatePersonalProject<PersonalProjectDetail>(await cloudApi(`${personalPath}/${encodeURIComponent(id)}`, cloudMutation(input, "PATCH")));
export const setPersonalProjectStatus = async (id: string, input: { requestId: string; status: PersonalProjectStatus; expectedRevision: number }) =>
  validatePersonalProject<PersonalProjectDetail>(await cloudApi(`${personalPath}/${encodeURIComponent(id)}/lifecycle`, cloudMutation(input)));
export const moveConversationToProject = (conversationId: string, input: { requestId: string; personalProjectId: string | null; expectedRevision: number }) =>
  cloudApi<CloudConversation>(`/conversations/${encodeURIComponent(conversationId)}/personal-project`, cloudMutation(input, "PUT"));

export async function listReferences(projectId: string, signal?: AbortSignal): Promise<PersonalProjectReference[]> {
  const result = await cloudApi<{ references: unknown[] }>(`${personalPath}/${encodeURIComponent(projectId)}/references`, { signal });
  if (!Array.isArray(result?.references)) throw unreadable();
  return result.references.map(validateReference);
}
export const uploadReference = async (projectId: string, file: File, requestId: string) =>
  validateReference(
    await cloudApi(
      `${personalPath}/${encodeURIComponent(projectId)}/references?name=${encodeURIComponent(file.name)}&requestId=${requestId}${file.type && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? `&mimeType=${encodeURIComponent(file.type)}` : ""}`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
    ),
  );
export const replaceReference = async (reference: PersonalProjectReference, file: File, requestId: string) =>
  validateReference(
    await cloudApi(
      `${personalPath}/${encodeURIComponent(reference.projectId)}/references/${encodeURIComponent(reference.id)}/content?requestId=${requestId}&expectedVersion=${reference.version}&expectedHash=${reference.sha256}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file },
    ),
  );
export const removeReference = (reference: PersonalProjectReference) =>
  cloudApi<void>(`${personalPath}/${encodeURIComponent(reference.projectId)}/references/${encodeURIComponent(reference.id)}?expectedVersion=${reference.version}&expectedHash=${reference.sha256}`, { method: "DELETE" });
export const referencePreviewPath = (reference: PersonalProjectReference) =>
  `${personalPath}/${encodeURIComponent(reference.projectId)}/references/${encodeURIComponent(reference.id)}/preview`;
export const referenceContentUrl = (reference: PersonalProjectReference) =>
  `/api/v1/work/cloud${personalPath}/${encodeURIComponent(reference.projectId)}/references/${encodeURIComponent(reference.id)}/content`;
export const referenceText = (reference: PersonalProjectReference) =>
  cloudApi<{ text: string; truncated: boolean }>(`${personalPath}/${encodeURIComponent(reference.projectId)}/references/${encodeURIComponent(reference.id)}/text?limit=200`);

export const getCreationPolicy = () => cloudApi<PersonalProjectCreationPolicy>(`${personalPath}/policy`);
export const saveCreationPolicy = (input: Omit<PersonalProjectCreationPolicy, "revision" | "defaultMaxPerMember"> & { expectedRevision: number }) =>
  cloudApi<PersonalProjectCreationPolicy>(`${personalPath}/policy`, cloudMutation(input, "PUT"));
