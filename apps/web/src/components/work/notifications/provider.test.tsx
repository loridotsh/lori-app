import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudApi } from "@/lib/cloud-work-api";
import { WorkNotificationsProvider } from "./provider";
import { NotificationSettings } from "./settings";
import { claimNotification, releaseNotification } from "./storage";
vi.mock("@/lib/cloud-work-api",()=>({cloudApi:vi.fn()}));
vi.mock("./storage",()=>({claimNotification:vi.fn(),releaseNotification:vi.fn()}));
const viewer={organization:{id:"org",name:"Org"},user:{id:"user",name:"User",email:"u@example.test"},role:"member" as const};
const scope=JSON.stringify(["org","user"]), key=`lori-work-notifications:${scope}`;
const event={id:"1",runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",conversationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",projectId:null,kind:"completed",createdAt:new Date().toISOString()};
const page={recipient:{organizationId:"org",userId:"user"},events:[event],serverTime:new Date().toISOString(),nextCursor:null};
const permission=vi.fn(), showNotification=vi.fn();
function open(){return render(<WorkNotificationsProvider viewer={viewer}><NotificationSettings/></WorkNotificationsProvider>);}
beforeEach(()=>{
 localStorage.clear();vi.stubGlobal("isSecureContext",true);vi.stubGlobal("Notification",{permission:"granted",requestPermission:permission});
 permission.mockResolvedValue("granted");showNotification.mockResolvedValue(undefined);
 Object.defineProperty(navigator,"serviceWorker",{configurable:true,value:{register:vi.fn().mockResolvedValue({active:{},showNotification}),getRegistration:vi.fn().mockResolvedValue({getNotifications:async()=>[]})}});
 Object.defineProperty(navigator,"onLine",{configurable:true,value:true});
 vi.stubGlobal("indexedDB",{});vi.mocked(cloudApi).mockResolvedValue(page);vi.mocked(claimNotification).mockResolvedValue(true);vi.mocked(releaseNotification).mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.unstubAllGlobals();});
it("does not ask permission or poll before explicit opt-in",async()=>{open();await screen.findByRole("switch",{name:"Work notifications"});expect(permission).not.toHaveBeenCalled();expect(cloudApi).not.toHaveBeenCalled();});
it("enables on click, delivers generic copy, and can mute",async()=>{open();fireEvent.click(await screen.findByRole("switch",{name:"Work notifications"}));await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(1));expect(permission).toHaveBeenCalledTimes(1);expect(showNotification.mock.calls[0]![0]).toBe("Work completed");fireEvent.click(screen.getByRole("switch",{name:"Work notifications"}));await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(false));});
it("does not deliver previously claimed events after reload",async()=>{localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));vi.mocked(claimNotification).mockResolvedValue(false);open();await waitFor(()=>expect(claimNotification).toHaveBeenCalled());expect(showNotification).not.toHaveBeenCalled();});
it("fails closed when the server account changes",async()=>{localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));vi.mocked(cloudApi).mockResolvedValue({...page,recipient:{organizationId:"other",userId:"user"}});open();await screen.findByText(/Your account changed/);expect(showNotification).not.toHaveBeenCalled();});
it("keeps opt-in off when permission is denied",async()=>{permission.mockResolvedValue("denied");open();fireEvent.click(await screen.findByRole("switch",{name:"Work notifications"}));await screen.findByRole("alert");expect(localStorage.getItem(key)).toBeNull();expect(showNotification).not.toHaveBeenCalled();});
it("cancels delivery when mute arrives during a pending request",async()=>{localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));let resolve!:(p:unknown)=>void;vi.mocked(cloudApi).mockReturnValue(new Promise(r=>{resolve=r;}));open();await waitFor(()=>expect(cloudApi).toHaveBeenCalled());await act(async()=>{localStorage.setItem(key,JSON.stringify({enabled:false,since:page.serverTime}));window.dispatchEvent(new StorageEvent("storage",{key}));resolve(page);});expect(showNotification).not.toHaveBeenCalled();});

it("leaves the application usable on insecure origins without secure-context APIs",async()=>{vi.stubGlobal("isSecureContext",false);vi.stubGlobal("crypto",{});open();await screen.findByText(/Use HTTPS/);expect((screen.getByRole("switch",{name:"Work notifications"}) as HTMLButtonElement).disabled).toBe(true);expect(cloudApi).not.toHaveBeenCalled();});
it("shows an explicit Off state before opt-in",async()=>{open();await screen.findByText("Off");expect(screen.queryByRole("button",{name:"Send test notification"})).toBeNull();});
it("sends a diagnostic notification without running a model or consuming a run event",async()=>{
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));vi.mocked(cloudApi).mockResolvedValue({...page,events:[]});open();
 const button=await screen.findByRole("button",{name:"Send test notification"});await waitFor(()=>expect((button as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(button);await waitFor(()=>expect(showNotification).toHaveBeenCalledWith("Lori notification test",expect.objectContaining({silent:false,data:{scope}})));
 expect(claimNotification).not.toHaveBeenCalled();await screen.findByText(/Test sent to your browser/);
});
it("shows blocked permission and keeps the test button disabled",async()=>{
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));vi.stubGlobal("Notification",{permission:"denied",requestPermission:permission});open();
 await screen.findByText("Paused");expect((screen.getByRole("button",{name:"Send test notification"}) as HTMLButtonElement).disabled).toBe(true);
 expect(showNotification).not.toHaveBeenCalled();
});

it("retries an event when browser display rejects instead of permanently consuming it", async () => {
 localStorage.setItem(key, JSON.stringify({enabled:true,since:page.serverTime}));
 showNotification.mockRejectedValueOnce(new Error("Temporary display failure"));
 open();
 await screen.findByRole("alert");
 expect(releaseNotification).toHaveBeenCalledWith(scope,event.id);
 window.dispatchEvent(new Event("focus"));
 await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(2));
 expect(screen.queryByRole("alert")).toBeNull();
 expect(releaseNotification).toHaveBeenCalledTimes(1);
});

it("suppresses delivery if the conversation becomes focused while storage is pending", async () => {
 const { trackVisibleConversation } = await import("./activity");
 localStorage.setItem(key, JSON.stringify({enabled:true,since:page.serverTime}));
 let finish!: (claimed:boolean)=>void;
 vi.mocked(claimNotification).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 vi.spyOn(document,"hasFocus").mockReturnValue(true);
 vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
 open(); await waitFor(()=>expect(claimNotification).toHaveBeenCalled());
 const stop = trackVisibleConversation(event);
 try {
  await act(async()=>{finish(true);});
  expect(showNotification).not.toHaveBeenCalled();
  expect(releaseNotification).not.toHaveBeenCalled();
 } finally { stop(); vi.restoreAllMocks(); }
});

it("releases a claim if muted before delivery finishes preparing", async () => {
 localStorage.setItem(key, JSON.stringify({enabled:true,since:page.serverTime}));
 let finish!: (claimed:boolean)=>void;
 vi.mocked(claimNotification).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 open(); await waitFor(()=>expect(claimNotification).toHaveBeenCalled());
 fireEvent.click(screen.getByRole("switch",{name:"Work notifications"}));
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(false));
 await act(async()=>{finish(true);});
 expect(showNotification).not.toHaveBeenCalled();
 expect(releaseNotification).toHaveBeenCalledWith(scope,event.id);
});

it("starts delivery immediately on reconnect and does not overlap in-flight scans", async () => {
 localStorage.setItem(key, JSON.stringify({enabled:true,since:page.serverTime}));
 Object.defineProperty(navigator,"onLine",{configurable:true,value:false});
 open(); await act(async()=>{}); expect(cloudApi).not.toHaveBeenCalled();
 Object.defineProperty(navigator,"onLine",{configurable:true,value:true});
 let finish!: (value:unknown)=>void;
 vi.mocked(cloudApi).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 window.dispatchEvent(new Event("online"));
 await waitFor(()=>expect(cloudApi).toHaveBeenCalledTimes(1));
 window.dispatchEvent(new Event("focus"));
 expect(cloudApi).toHaveBeenCalledTimes(1);
 await act(async()=>{finish(page);});
 await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(1));
});

it("can turn off a saved preference when notification APIs are unavailable", async () => {
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));
 vi.stubGlobal("isSecureContext",false);
 vi.stubGlobal("Notification",undefined);
 Object.defineProperty(navigator,"serviceWorker",{configurable:true,value:undefined});
 open();
 fireEvent.click(await screen.findByRole("switch",{name:"Work notifications"}));
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(false));
 expect(screen.queryByRole("alert")).toBeNull();
});

it("recovers corrupt saved preferences without claiming that storage is blocked", async () => {
 localStorage.setItem(key,"{broken"); open();
 await screen.findByText("Off"); expect(screen.queryByRole("alert")).toBeNull();
 fireEvent.click(screen.getByRole("switch",{name:"Work notifications"}));
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(true));
});

it("requests a fresh alert for later events while retaining one tray entry per conversation", async () => {
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));
 open(); await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(1));
 vi.mocked(cloudApi).mockResolvedValue({...page,events:[{...event,id:"2",kind:"approval"}]});
 window.dispatchEvent(new Event("focus"));
 await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(2));
 const first=showNotification.mock.calls[0]![1], second=showNotification.mock.calls[1]![1];
 expect(first.tag).toBe(second.tag);
 expect(second).toMatchObject({renotify:true,silent:true});
 expect(showNotification.mock.calls[1]![0]).toBe("Work needs approval");
});

it("does not let late cleanup from an old scan close a newer notification", async () => {
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));
 let finish!: ()=>void;
 showNotification.mockImplementationOnce(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const older={data:{scope,eventId:event.id},close:vi.fn()};
 const newer={data:{scope,eventId:"newer-event"},close:vi.fn()};
 vi.mocked(navigator.serviceWorker.register).mockResolvedValue({active:{},showNotification,getNotifications:async()=>[older,newer]} as unknown as ServiceWorkerRegistration);
 const view=open(); await waitFor(()=>expect(showNotification).toHaveBeenCalledTimes(1));
 view.unmount();
 await act(async()=>{finish();});
 expect(older.close).toHaveBeenCalledTimes(1);
 expect(newer.close).not.toHaveBeenCalled();
});

it("does not let a slow mute cleanup close alerts after another tab opts in again", async () => {
 localStorage.setItem(key,JSON.stringify({enabled:true,since:page.serverTime}));
 vi.mocked(cloudApi).mockResolvedValue({...page,events:[]});
 let finish!: (value:ServiceWorkerRegistration | undefined)=>void;
 vi.mocked(navigator.serviceWorker.getRegistration).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const notification={data:{scope},close:vi.fn()};
 open();
 fireEvent.click(await screen.findByRole("switch",{name:"Work notifications"}));
 await waitFor(()=>expect(JSON.parse(localStorage.getItem(key)!).enabled).toBe(false));
 await act(async()=>{
  localStorage.setItem(key,JSON.stringify({enabled:true,since:new Date(Date.parse(page.serverTime)+1000).toISOString()}));
  window.dispatchEvent(new StorageEvent("storage",{key}));
  finish({getNotifications:async()=>[notification]} as unknown as ServiceWorkerRegistration);
 });
 expect(notification.close).not.toHaveBeenCalled();
});
