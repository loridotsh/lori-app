import type { IncomingHttpHeaders } from "node:http";
import { IdentityError } from "../../auth/identity-service.js";
export function requireDesktopProjectProtocol(headers: IncomingHttpHeaders): void {
  if (headers["x-lori-project-client-version"] !== "1")
    throw new IdentityError(426, "project_client_update_required", "Update Lori and Enterprise to matching versions to use desktop projects.");
}
