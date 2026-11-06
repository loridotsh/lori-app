import type { CloudConversationDetail } from "@lori-enterprise/contracts";

/** Keep loaded earlier pages through reconciliation, with fresh receipts winning.
 * Preserve server ordering instead of re-sorting microsecond timestamps rounded by JSON dates.
 */
export function mergeHistoryPage(previous: CloudConversationDetail, incoming: CloudConversationDetail, older = false): CloudConversationDetail {
  if (previous.conversation.id !== incoming.conversation.id) return incoming;
  const merge = <T extends { id: string }>(a: T[] = [], b: T[] = []): T[] => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
  if (older) return { ...previous,
    activityTruncated: previous.activityTruncated || incoming.activityTruncated,
    messages: [...new Map([...incoming.messages, ...previous.messages].map(message => [`${message.runId}:${message.role}`, message])).values()],
    toolInvocations: merge(incoming.toolInvocations, previous.toolInvocations),
    approvals: merge(incoming.approvals, previous.approvals),
    runs: [...previous.runs, ...incoming.runs.filter(run => !previous.runs.some(current => current.id === run.id))],
    historyCursor: incoming.historyCursor,
  };
  return { ...incoming,
    activityTruncated: previous.activityTruncated || incoming.activityTruncated,
    messages: [...new Map([...previous.messages, ...incoming.messages].map(message => [`${message.runId}:${message.role}`, message])).values()],
    toolInvocations: merge(previous.toolInvocations, incoming.toolInvocations),
    approvals: merge(previous.approvals, incoming.approvals),
    runs: [...incoming.runs, ...previous.runs.filter(run => !incoming.runs.some(fresh => fresh.id === run.id))],
    historyCursor: previous.historyCursor === undefined ? incoming.historyCursor : previous.historyCursor,
  };
}
