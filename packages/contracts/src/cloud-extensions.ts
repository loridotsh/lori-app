/** Member-private Cloud Work extension metadata. Credentials never appear in this contract. */
export interface CloudPlugin {
  id: string;
  name: string;
  description?: string;
  auth: string;
  docsUrl: string;
  setup: string;
  allowed: boolean;
  connection: CloudPluginConnection | null;
}
export interface CloudPluginConnection {
  id: string;
  revision: number;
  status: "connecting" | "connected" | "disconnected" | "reauthRequired";
  enabled: boolean;
  toolCount: number;
  resourceCount: number;
  updatedAt: string;
}
export interface CloudSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  capability: string;
  references: string[];
  allowed: boolean;
  enabled: boolean;
}
export interface CloudExtensionsSnapshot {
  plugins: CloudPlugin[];
  skills: CloudSkill[];
  callbackUrl: string | null;
}
export interface CloudPluginTool {
  pluginId: string;
  connectionId: string;
  connectionRevision: number;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  schemaHash: string;
  readOnly: boolean;
}
export interface CloudAuthorizationStart {
  connectionId: string;
  authorizationUrl: string;
  expiresAt: string;
}
