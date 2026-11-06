import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { workApi } from "@/lib/work-api";
import { WorkModelPricing } from "./work-model-pricing";
vi.mock("@/lib/work-api",()=>({workApi:vi.fn()}));
beforeEach(()=>vi.mocked(workApi).mockReset());
it("saves explicit rates in USD per million without converting blank cache rates into zero",async()=>{
 vi.mocked(workApi).mockResolvedValueOnce({pricing:{},revision:7}).mockResolvedValueOnce({pricing:{custom:{input:2,output:10}},revision:8});
 const saved=vi.fn();render(<WorkModelPricing gatewayId="g" models={["custom"]} disabled={false} onSaved={saved}/>);
 fireEvent.click(screen.getByText("Custom pricing"));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save model pricing"}).hasAttribute("disabled")).toBe(false));
 fireEvent.change(screen.getByLabelText("Input"),{target:{value:"2"}});
 fireEvent.change(screen.getByLabelText("Output"),{target:{value:"10"}});
 fireEvent.click(screen.getByRole("button",{name:"Save model pricing"}));
 await waitFor(()=>expect(saved).toHaveBeenCalledWith(8));
 const request=vi.mocked(workApi).mock.calls.find(([,init])=>init?.method==="POST")!;
 expect(JSON.parse(request[1]!.body as string)).toMatchObject({modelId:"custom",expectedRevision:7,pricing:{input:2,output:10,unit:"perMillionTokens"}});
 expect(JSON.parse(request[1]!.body as string).pricing.cacheRead).toBeUndefined();
});

it("asks for a model before offering pricing and only offers a reset for an existing override",async()=>{
 vi.mocked(workApi).mockResolvedValue({pricing:{},revision:7});
 const view=render(<WorkModelPricing gatewayId="g" models={[]} disabled={false}/>);fireEvent.click(screen.getByText("Custom pricing"));
 expect(screen.getByText("Allow a model to set its pricing.")).toBeTruthy();
 view.rerender(<WorkModelPricing gatewayId="g" models={["custom"]} disabled={false}/>);
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save model pricing"}).hasAttribute("disabled")).toBe(false));
 expect(screen.queryByRole("button",{name:"Use provider pricing"})).toBeNull();
});

it("offers reload only after pricing fails to load",async()=>{
 vi.mocked(workApi).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({pricing:{},revision:7});
 render(<WorkModelPricing gatewayId="g" models={["custom"]} disabled={false}/>);fireEvent.click(screen.getByText("Custom pricing"));
 fireEvent.click(await screen.findByRole("button",{name:"Reload pricing"}));
 await waitFor(()=>expect(screen.queryByRole("button",{name:"Reload pricing"})).toBeNull());
 await waitFor(()=>expect(screen.getByRole("button",{name:"Save model pricing"}).hasAttribute("disabled")).toBe(false));
});

it("can remove an override despite an invalid unsaved rate",async()=>{
 vi.mocked(workApi).mockResolvedValueOnce({pricing:{custom:{input:2}},revision:7}).mockResolvedValueOnce({pricing:{},revision:8});
 render(<WorkModelPricing gatewayId="g" models={["custom"]} disabled={false}/>);fireEvent.click(screen.getByText("Custom pricing"));
 await waitFor(()=>expect(screen.getByRole("button",{name:"Use provider pricing"}).hasAttribute("disabled")).toBe(false));
 fireEvent.change(screen.getByLabelText("Input"),{target:{value:"-5"}});
 fireEvent.click(screen.getByRole("button",{name:"Use provider pricing"}));
 await waitFor(()=>expect(vi.mocked(workApi).mock.calls.some(([,init])=>init?.method==="POST")).toBe(true));
 const request=vi.mocked(workApi).mock.calls.find(([,init])=>init?.method==="POST")!;
 expect(JSON.parse(request[1]!.body as string).pricing).toBeNull();
});
it("preserves long-context rates when editing base rates",async()=>{
 const tier={above:100000,input:4,output:20};
 vi.mocked(workApi).mockResolvedValueOnce({pricing:{custom:{input:2,output:10,longContext:tier}},revision:7}).mockResolvedValueOnce({pricing:{},revision:8});
 render(<WorkModelPricing gatewayId="g" models={["custom"]} disabled={false}/>);fireEvent.click(screen.getByText("Custom pricing"));
 await waitFor(()=>expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("2"));
 fireEvent.change(screen.getByLabelText("Input"),{target:{value:"3"}});fireEvent.click(screen.getByRole("button",{name:"Save model pricing"}));
 await waitFor(()=>expect(vi.mocked(workApi).mock.calls.some(([,init])=>init?.method==="POST")).toBe(true));
 expect(JSON.parse(vi.mocked(workApi).mock.calls.find(([,init])=>init?.method==="POST")![1]!.body as string).pricing.longContext).toEqual(tier);
});
it("ignores an old save response after switching providers",async()=>{
 let finish!: (value:unknown)=>void;
 vi.mocked(workApi).mockResolvedValueOnce({pricing:{a:{input:2}},revision:7}).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({pricing:{b:{input:4}},revision:10});
 const saved=vi.fn();const view=render(<WorkModelPricing gatewayId="a" models={["a"]} disabled={false} onSaved={saved}/>);fireEvent.click(screen.getByText("Custom pricing"));
 await waitFor(()=>expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("2"));fireEvent.click(screen.getByRole("button",{name:"Save model pricing"}));
 view.rerender(<WorkModelPricing gatewayId="b" models={["b"]} disabled={false} onSaved={saved}/>);
 await waitFor(()=>expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("4"));
 finish({pricing:{a:{input:2}},revision:8});await waitFor(()=>expect(saved).not.toHaveBeenCalled());
 expect((screen.getByLabelText("Input") as HTMLInputElement).value).toBe("4");
});
