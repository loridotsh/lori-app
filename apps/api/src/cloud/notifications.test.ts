import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { IdentityError } from "../auth/identity-service.js";
import type { CloudWorkService } from "./service.js";
import { notifications, registerNotificationRoutes } from "./notifications.js";
const actor={organizationId:"org",memberId:"member",userId:"user",role:"member" as const};
const row={id:"1",run_id:"run",conversation_id:"conversation",project_id:null as string | null,approval_id:null,kind:"completed",created_at:new Date()};
function fixture(rows=[row]) {
  const query=vi.fn(async (sql:string) => ({rows:sql.includes("clock_timestamp")?[{now:new Date()}]:sql.includes("LIMIT 101")?rows:sql.includes("JOIN cloud_work_runs")?rows:[],rowCount:0}));
  const ensure=vi.fn(async()=>{}), authorize=vi.fn(async()=>{});
  const cloud={transaction:async (run:(c:unknown)=>unknown)=>run({query}),ensure,projects:{authorize},actor:async()=>actor} as unknown as CloudWorkService;
  return {cloud,query,ensure,authorize};
}
describe("Work notification feed",()=>{
  it("uses only the authenticated member and returns no content fields",async()=>{
    const {cloud,query,ensure}=fixture();
    const result=await notifications(cloud,actor,{since:new Date().toISOString()});
    expect(result.events[0]).toEqual({id:"1",runId:"run",conversationId:"conversation",projectId:null,approvalId:null,kind:"completed",createdAt:row.created_at.toISOString()});
    expect(result.recipient).toEqual({organizationId:"org",userId:"user"});
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.find(([sql])=>sql.includes("LIMIT 101"))?.[0]).toContain("member_id=$2");
  });
  it("does not return events whose resource is no longer authorized",async()=>{
    const {cloud,authorize}=fixture([{...row,project_id:"project"} as typeof row]);
    authorize.mockRejectedValue(new IdentityError(404,"project_not_found","Missing"));
    expect((await notifications(cloud,actor,{since:new Date().toISOString()})).events).toEqual([]);
  });
  it("keeps pagination moving even when every event on a page was revoked",async()=>{
    const {cloud,authorize}=fixture(Array.from({length:101},(_,i)=>({...row,id:String(101-i),project_id:"p"} as typeof row)));
    authorize.mockRejectedValue(new IdentityError(404,"project_not_found","Missing"));
    expect(await notifications(cloud,actor,{since:new Date().toISOString()})).toMatchObject({events:[],nextCursor:"2"});
  });
  it("rejects invalid cursors, dates, and supplied member selectors before SQL",async()=>{
    const {cloud,query}=fixture();const app=Fastify();registerNotificationRoutes(app,cloud);
    for(const suffix of ["since=nope","since=2026-10-23T00%3A00%3A00Z&before=-1","since=2026-10-23T00%3A00%3A00Z&before=9999999999999999999","since=2026-10-23T00%3A00%3A00Z&memberId=victim"]){expect((await app.inject(`/v1/work/cloud/notifications?${suffix}`)).statusCode).not.toBe(200);}
    expect(query).not.toHaveBeenCalled();await app.close();
  });
});
