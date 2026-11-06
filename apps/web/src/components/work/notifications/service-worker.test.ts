// @vitest-environment node
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
const source=readFileSync(resolve(import.meta.dirname,"../../../../public/work-notifications.js"),"utf8");
function worker(){
 const handlers=new Map<string,(event:unknown)=>void>(),openWindow=vi.fn(async()=>null);
 runInNewContext(source,{URL,self:{location:{origin:"https://enterprise.test"},clients:{openWindow},addEventListener:(name:string,fn:(event:unknown)=>void)=>handlers.set(name,fn)}});
 return {openWindow,click:(path:unknown)=>{const close=vi.fn(),waitUntil=vi.fn();handlers.get("notificationclick")!({notification:{data:{path},close},waitUntil});return {close,waitUntil};}};
}
it("opens only a validated same-origin conversation and removes unexpected query parameters",()=>{
 const w=worker(),id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 expect(w.click(`/work/cloud?conversation=${id}&callback=https://evil.test`).close).toHaveBeenCalled();
 expect(w.openWindow).toHaveBeenCalledWith(`https://enterprise.test/work/cloud?conversation=${id}`);
});
it("ignores malformed or external notification destinations",()=>{
 const w=worker();for(const path of [null,"http://[","https://evil.test/work/cloud","/work/cloud?conversation=../private","/work/projects?conversation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]){expect(()=>w.click(path)).not.toThrow();}
 expect(w.openWindow).not.toHaveBeenCalled();
});
