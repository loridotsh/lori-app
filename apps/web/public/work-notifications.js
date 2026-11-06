/* No fetch handler or cached account data. This worker only handles notification clicks. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = event.notification.data?.path;
  if (typeof path !== "string") return;
  let url;
  try { url = new URL(path, self.location.origin); } catch { return; }
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (url.origin !== self.location.origin || url.pathname !== "/work/cloud" || !uuid.test(url.searchParams.get("conversation") || "") || (url.searchParams.has("project") && !uuid.test(url.searchParams.get("project")))) return;
  // Open a new authorized route instead of navigating an existing tab over an unsaved draft.
  const destination = new URL("/work/cloud", self.location.origin);
  destination.searchParams.set("conversation", url.searchParams.get("conversation"));
  if (url.searchParams.has("project")) destination.searchParams.set("project", url.searchParams.get("project"));
  event.waitUntil(self.clients.openWindow(destination.href));
});
