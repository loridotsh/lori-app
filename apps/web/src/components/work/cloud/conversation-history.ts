import type { CloudConversation } from "@lori-enterprise/contracts";

/** Navigation is a read, not activity. Keep server update times authoritative. */
export function mergeConversationHistory(
  previous: CloudConversation[],
  incoming: CloudConversation[],
): CloudConversation[] {
  const byId = new Map(previous.map((conversation) => [conversation.id, conversation]));
  for (const conversation of incoming) {
    const current = byId.get(conversation.id);
    // A delayed detail/page response must not undo a newer send or rename.
    if (!current || conversation.revision > current.revision || (
      conversation.revision === current.revision &&
      Date.parse(conversation.updatedAt) >= Date.parse(current.updatedAt)
    )) byId.set(conversation.id, conversation);
  }
  // Stable ties retain the API's existing order: PostgreSQL timestamps can
  // have finer precision than the milliseconds exposed in JSON.
  return [...byId.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
