import { ClientApiError } from "@/lib/client-api";

/** Public connection metadata only; upstream keys never belong in this shape. */
export interface WorkProviderConnection {
  id: string;
  providerId: string;
  providerName: string;
  credentialConfigured: true;
  requestsPerMinute: number;
  policyRevision: number;
  createdAt: string;
  updatedAt: string;
  /** Present when the provider's listing can safely enable all of its usable models. */
  modelSync?: { enabled: boolean; modelIds: string[] };
}
export interface WorkProviderConnections {
  providerGateways: WorkProviderConnection[];
  revision: number;
}
export function validWorkModelId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}
export function connectionFailure(reason: unknown): {
  message: string;
  reload: boolean;
  signIn: boolean;
  retryAfterSeconds?: number;
} {
  if (reason instanceof ClientApiError) {
    if (reason.status === 401)
      return {
        message:
          "Your session expired. Sign in again to manage company connections.",
        reload: false,
        signIn: true,
      };
    if (reason.status === 403)
      return {
        message:
          "Only organization administrators can manage company keys. Reload to check your current access.",
        reload: true,
        signIn: false,
      };
    if (reason.status === 409)
      return {
        message:
          "Company settings changed while this page was open. Reload the latest policy before trying again.",
        reload: true,
        signIn: false,
      };
    if (reason.status === 400 || reason.status === 422)
      return {
        message:
          "The company connection could not be saved. Check the key and try again.",
        reload: false,
        signIn: false,
      };
    if (reason.status === 429)
      return {
        message: "Too many requests. Wait before trying again.",
        reload: false,
        signIn: false,
        retryAfterSeconds: Math.min(
          300,
          Math.max(1, reason.retryAfterSeconds ?? 30),
        ),
      };
  }
  // A key submission's server response is never rendered verbatim: even a
  // misconfigured upstream cannot echo a credential into the interface.
  return {
    message:
      "The company connection could not be saved or loaded. Check your connection and try again.",
    reload: false,
    signIn: false,
  };
}

export function validConnection(
  value: unknown,
): value is WorkProviderConnection {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkProviderConnection>;
  return (
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.providerId === "string" &&
    item.providerId.length > 0 &&
    typeof item.providerName === "string" &&
    item.credentialConfigured === true &&
    Number.isSafeInteger(item.policyRevision) &&
    item.policyRevision! >= 0 &&
    Number.isInteger(item.requestsPerMinute) &&
    item.requestsPerMinute! >= 1 &&
    item.requestsPerMinute! <= 600
  );
}
export function validConnections(
  value: unknown,
): value is WorkProviderConnections {
  if (!value || typeof value !== "object") return false;
  const response = value as Partial<WorkProviderConnections>;
  return (
    Number.isSafeInteger(response.revision) &&
    response.revision! >= 0 &&
    Array.isArray(response.providerGateways) &&
    response.providerGateways.every(validConnection) &&
    new Set(response.providerGateways.map((item) => item.providerId)).size ===
      response.providerGateways.length &&
    new Set(response.providerGateways.map((item) => item.id)).size ===
      response.providerGateways.length
  );
}
