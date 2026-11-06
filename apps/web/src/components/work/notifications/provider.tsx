"use client";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Viewer } from "@lori-enterprise/contracts";
import { cloudApi } from "@/lib/cloud-work-api";
import { ClientApiError } from "@/lib/client-api";
import { notificationCopy, notificationPath, parsePage } from "./protocol";
import { publishVisible, visibleInAnotherTab, isConversationVisible } from "./activity";
import { claimNotification, releaseNotification } from "./storage";

async function readPage(path: string, parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try { return parsePage(await cloudApi(path, { signal: controller.signal })); }
  finally { clearTimeout(timer); parent?.removeEventListener("abort", abort); }
}
type Preference = { enabled: boolean; since: string };
type BrowserPermission = NotificationPermission | "unsupported";
const Context = createContext({ enabled: false, busy: false, error: "", supported: false, permission: "unsupported" as BrowserPermission, testing: false, testResult: "", toggle: async () => {}, testNotification: async () => {} });
export const useWorkNotifications = () => useContext(Context);
const changed = "lori-work-notifications-changed";
function read(key: string): Preference {
  const stored = localStorage.getItem(key);
  let value: Preference | null = null;
  try { value = JSON.parse(stored ?? "null"); } catch { /* Discard a corrupt preference, not the user's ability to save it. */ }
  return value && typeof value.enabled === "boolean" && typeof value.since === "string" && Number.isFinite(Date.parse(value.since))
    ? { enabled: value.enabled, since: new Date(value.since).toISOString() }
    : { enabled: false, since: new Date().toISOString() };
}
async function registration(): Promise<ServiceWorkerRegistration> {
  const result = await navigator.serviceWorker.register("/work-notifications.js", { scope: "/work/", updateViaCache: "none" });
  if (result.active) return result;
  await new Promise<void>((resolve, reject) => {
    const worker = result.installing ?? result.waiting;
    if (!worker) { reject(new Error("Notifications could not start. Reload and try again.")); return; }
    const timer = setTimeout(() => { worker.removeEventListener("statechange", check); reject(new Error("Notifications took too long to start. Try again.")); }, 10000);
    function check() { if (worker?.state === "activated" || worker?.state === "redundant") { clearTimeout(timer); worker.removeEventListener("statechange", check); if (worker.state === "activated") resolve(); else reject(new Error("Notifications could not start. Try again.")); } }
    worker.addEventListener("statechange", check); check();
  });
  return result;
}
export function WorkNotificationsProvider({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const scope = JSON.stringify([viewer.organization.id, viewer.user.id]);
  const key = `lori-work-notifications:${scope}`;
  const [preference, setPreference] = useState<Preference>({ enabled: false, since: new Date().toISOString() });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<BrowserPermission>("unsupported"), [testing, setTesting] = useState(false), [testResult, setTestResult] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const available = window.isSecureContext && "Notification" in window && "serviceWorker" in navigator && "indexedDB" in window;
    setSupported(available);
    const refreshPermission = () => setPermission(available ? Notification.permission : "unsupported");
    refreshPermission(); window.addEventListener("focus", refreshPermission);
    const sync = (event?: Event) => { if (event instanceof StorageEvent && event.key !== key && event.key !== null) return; if (event instanceof StorageEvent) {++generation.current; setBusy(false);} try { setPreference(read(key)); setError(""); } catch { setPreference({ enabled: false, since: new Date().toISOString() }); setError("Browser storage is unavailable. Allow site storage to enable notifications."); } };
    sync(); window.addEventListener("storage", sync); window.addEventListener(changed, sync);
    return () => { ++generation.current; window.removeEventListener("focus", refreshPermission); window.removeEventListener("storage", sync); window.removeEventListener(changed, sync); };
  }, [key]);
  useEffect(() => {
    if (!supported || !preference.enabled) return;
    const tab = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    return publishVisible(scope, tab);
  }, [scope, supported, preference.enabled]);
  useEffect(() => {
    if (!supported || !preference.enabled) return;
    let stopped = false, running = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const stillEnabled = () => {
      if (stopped) return false;
      const saved = read(key);
      return saved.enabled && saved.since === preference.since;
    };
    // Full bounded-age scans avoid sequence/commit-order races and retain events
    // arriving during offline periods. Receipts prevent redelivery after reload.
    async function scan() {
      if (stopped || !navigator.onLine) return;
      try {
        setPermission(Notification.permission);
        if (Notification.permission !== "granted") throw new Error("Notifications are blocked. Allow them in your browser’s site settings.");
        const reg = await registration();
        let cursor: string | null = null;
        const cursors = new Set<string>();
        const conversations = new Set<string>();
        do {
          const page = await readPage(`/notifications?${new URLSearchParams({ since: preference.since, ...(cursor ? { before: cursor } : {}) })}`, controller.signal);
          if (JSON.stringify([page.recipient.organizationId, page.recipient.userId]) !== scope) throw new Error("Your account changed. Reload Lori before enabling notifications.");
          for (const event of page.events) {
            if (!stillEnabled()) return;
            const alreadyRepresented = conversations.has(event.conversationId);
            conversations.add(event.conversationId);
            if (!(await claimNotification(scope, event.id))) continue;
            if (alreadyRepresented) continue;
            let delivered = false;
            try {
              // Claiming storage is asynchronous: focus or mute may have changed
              // while it was pending. Recheck immediately before OS delivery.
              if (!stillEnabled() || Notification.permission !== "granted") return;
              if (isConversationVisible(event.conversationId, event.projectId) || visibleInAnotherTab(scope, event.conversationId, event.projectId)) {
                delivered = true; // Reading the conversation intentionally consumes the alert.
                continue;
              }
              const copy = notificationCopy(event.kind);
              const tag = `lori-work:${scope}:${event.conversationId}`;
              // Reusing a conversation tag keeps the tray compact. Request a
              // fresh alert when a later event replaces its previous banner.
              const options = { body: copy.body, tag, renotify: true, data: { path: notificationPath(event), scope, eventId: event.id }, silent: true };
              await reg.showNotification(copy.title, options);
              delivered = true;
              // Muting/unmounting may race the OS delivery promise.
              if (!stillEnabled()) for (const notification of await reg.getNotifications({ tag })) {
                if (notification.data?.eventId === event.id) notification.close();
              }
            } finally {
              if (!delivered) await releaseNotification(scope, event.id);
            }
          }
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error("Notification history could not be loaded. Try again.");
          if (cursor) cursors.add(cursor);
        } while (cursor && !stopped);
        if (!stopped) setError("");
      } catch (failure) {
        if (!stopped) setError(failure instanceof ClientApiError && [401,403].includes(failure.status) ? "Notifications are paused. Sign in and check your Work access." : failure instanceof Error ? failure.message : "Notifications are paused. Check your connection.");
      }
    }
    async function tick() {
      if (stopped || running) return;
      running = true;
      try {
        if (navigator.locks) await navigator.locks.request(`lori-work-notifications:${scope}`, { ifAvailable: true }, async lock => { if (lock) await scan(); });
        else await scan();
      } catch { if (!stopped) setError("Notifications are paused. Reload Lori to try again."); }
      finally { running = false; if (!stopped) timer = setTimeout(() => void tick(), 15000); }
    }
    const wake = () => { clearTimeout(timer); void tick(); };
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    void tick();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); window.removeEventListener("online", wake); window.removeEventListener("focus", wake); };
  }, [key, preference.enabled, preference.since, scope, supported]);
  const toggle = async () => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true); setError(""); setTestResult("");
    try {
      if (!supported && !preference.enabled) throw new Error("Notifications need HTTPS and a browser that supports system notifications.");
      // Request synchronously from the click, before awaiting network or storage.
      const permission = preference.enabled ? null : await Notification.requestPermission();
      setPermission(supported ? Notification.permission : "unsupported");
      if (permission && permission !== "granted") throw new Error("Notifications were not enabled. You can allow them in your browser’s site settings.");
      let since = preference.since;
      if (!preference.enabled) {
        await registration();
        const baseline = await readPage(`/notifications?since=${encodeURIComponent(new Date().toISOString())}`);
        if (JSON.stringify([baseline.recipient.organizationId, baseline.recipient.userId]) !== scope) throw new Error("Your account changed. Reload Lori before enabling notifications.");
        since = baseline.serverTime;
      }
      if (current !== generation.current) return;
      const next = { enabled: !preference.enabled, since };
      localStorage.setItem(key, JSON.stringify(next)); setPreference(next); window.dispatchEvent(new Event(changed));
      if (!next.enabled) {
        const reg = await navigator.serviceWorker?.getRegistration("/work/");
        const displayed = await reg?.getNotifications() ?? [];
        if (current === generation.current && !read(key).enabled) {
          for (const notification of displayed) if (notification.data?.scope === scope) notification.close();
        }
      }
    } catch (failure) { if (current === generation.current) setError(failure instanceof Error ? failure.message : "Could not save notification settings."); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const testNotification = async () => {
    if (testing || busy || !preference.enabled) return;
    const epoch = generation.current;
    setTesting(true); setError(""); setTestResult("");
    try {
      if (!supported || Notification.permission !== "granted") throw new Error("Allow notifications in your browser’s site settings, then try again.");
      const reg = await registration();
      if (epoch !== generation.current || !read(key).enabled) return;
      const tag = `lori-work-test:${scope}`;
      const options = { body: "Work notifications are enabled for this browser.", tag, renotify: true, data: { scope }, silent: false };
      await reg.showNotification("Lori notification test", options);
      if (epoch !== generation.current || !read(key).enabled) { for (const item of await reg.getNotifications({ tag })) item.close(); return; }
      setTestResult("Test sent to your browser. If no banner appears, check your system’s notification settings for this browser and Do Not Disturb / Focus.");
    } catch (failure) { if (epoch === generation.current) setError(failure instanceof Error ? failure.message : "Could not send the test notification."); }
    finally { setTesting(false); }
  };
  return <Context.Provider value={{ enabled: preference.enabled, busy, error, supported, permission, testing, testResult, toggle, testNotification }}>{children}</Context.Provider>;
}
