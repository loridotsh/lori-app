type ConversationTarget = { conversationId: string; projectId: string | null };
let current: ConversationTarget | null = null;
const changed = "lori-work-visible-conversation";
// Private Cloud conversations do not put their IDs in the address bar.
// Visibility must follow the actual mounted conversation, not the URL.
export function trackVisibleConversation(target: ConversationTarget | null): () => void {
  current = target;
  window.dispatchEvent(new Event(changed));
  return () => { if (current === target) { current = null; window.dispatchEvent(new Event(changed)); } };
}
export function isConversationVisible(conversationId: string, projectId: string | null): boolean {
  return document.visibilityState === "visible" && document.hasFocus() && current?.conversationId === conversationId && current.projectId === projectId;
}
const prefix = "lori-work-visible:";
export function publishVisible(scope: string, tab: string): () => void {
  const key = `${prefix}${scope}:${tab}`;
  const update = () => {
    try {
      if (current && document.visibilityState === "visible" && document.hasFocus()) localStorage.setItem(key, JSON.stringify({ ...current, at: Date.now() }));
      else localStorage.removeItem(key);
    } catch { /* Delivery itself fails closed if receipts cannot be persisted. */ }
  };
  const clear = () => { try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } };
  window.addEventListener("pagehide", clear); window.addEventListener("pageshow", update);
  update(); const timer = setInterval(update, 2000);
  window.addEventListener(changed, update); window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
  return () => { window.removeEventListener("pagehide", clear); window.removeEventListener("pageshow", update); clearInterval(timer); window.removeEventListener(changed, update); window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ } };
}
export function visibleInAnotherTab(scope: string, conversationId: string, projectId: string | null) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key?.startsWith(`${prefix}${scope}:`)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!value || typeof value.at !== "number" || Date.now() - value.at > 6000) { localStorage.removeItem(key); continue; }
      if (value.conversationId === conversationId && value.projectId === projectId) return true;
    } catch { localStorage.removeItem(key); }
  }
  return false;
}
