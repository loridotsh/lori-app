import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTodoWrite } from "@lori-enterprise/contracts";
import { cloudToolDefinitions, getCloudTools, normalizeCloudCall } from "./tools.js";
const fixtures=JSON.parse(readFileSync(new URL("../../../worker/vendor/work-core/src/todos.fixtures.json",import.meta.url),"utf8")) as {name:string;valid:boolean;arguments:unknown}[];
describe("shared todo contract",()=>{
  it("offers conversation task lists without a plugin or document runtime", () => {
    for (const isolated of [false,true]) for (const name of ["read_todos","write_todos"])
      expect(getCloudTools(isolated).filter(tool => tool.name === name)).toHaveLength(1);
  });
  it.each(fixtures)("$name", fixture=>expect(parseTodoWrite(fixture.arguments)!==null).toBe(fixture.valid));
  it("offers the same bounded schema as the native harness",()=>{
    const schema=JSON.parse(readFileSync(new URL("../../../worker/vendor/work-core/src/todos.schema.json",import.meta.url),"utf8"));
    expect(cloudToolDefinitions.find(tool=>tool.name==="write_todos")!.parameters).toEqual(schema);
    expect(normalizeCloudCall({id:"todo",name:"write_todos",arguments:{expectedRevision:"2",todos:[{id:"a",content:"Review",status:"pending"}]}}).arguments.expectedRevision).toBe(2);
  });
});
