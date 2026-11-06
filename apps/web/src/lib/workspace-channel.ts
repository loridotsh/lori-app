const CHANNEL = "lori-workspace";
const thisTab = Math.random().toString(36).slice(2);

/**
 * The active workspace belongs to the browser session, which every tab shares.
 * A tab left open on the old workspace would otherwise act in the new one, so
 * each change reaches the others at once.
 */
export function announceWorkspaceChange() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(thisTab);
  channel.close();
}

export function onWorkspaceChange(listener: () => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<string>) => {
    if (event.data !== thisTab) listener();
  };
  return () => channel.close();
}
