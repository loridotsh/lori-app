import { describe, expect, it } from "vitest";
import { notificationCopy, notificationPath, parsePage } from "./protocol";
const event={id:"1",runId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",conversationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",projectId:null,kind:"approval",createdAt:new Date().toISOString()};
const page={recipient:{organizationId:"org",userId:"user"},events:[event],serverTime:new Date().toISOString(),nextCursor:null};
describe("notification protocol",()=>{
  it("builds only an internal conversation URL",()=>{expect(notificationPath(event)).toBe(`/work/cloud?conversation=${event.conversationId}`);expect(()=>notificationPath({...event,conversationId:"https://evil.test"})).toThrow();});
  it("rejects malformed events and unsupported states",()=>{expect(parsePage(page)).toEqual(page);for(const changed of [{kind:"cancelled"},{id:"-1"},{createdAt:"bad"},{projectId:"../"}])expect(()=>parsePage({...page,events:[{...event,...changed}]})).toThrow();});
  it("uses generic copy for all attention states",()=>{expect(notificationCopy("approval").body).toContain("review");expect(notificationCopy("completed").title).toBe("Work completed");expect(notificationCopy("interrupted")).toEqual(notificationCopy("failed"));});
});
