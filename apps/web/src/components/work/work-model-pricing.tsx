"use client";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { workApi } from "@/lib/work-api";
import { validWorkModelId } from "./work-provider-utils";
const fields = [["input","Input"],["output","Output"],["cacheRead","Cache read"],["cacheWrite","Cache write, 5 min"],["cacheWrite1h","Cache write, 1 hour"]] as const;
type Rates = Partial<Record<typeof fields[number][0], number>> & { longContext?: { above: number } & Partial<Record<typeof fields[number][0], number>> };
type Result = { pricing: Record<string, Rates>; revision: number };
export function WorkModelPricing({ gatewayId, models, disabled, onSaved }: { gatewayId: string; models: readonly string[]; disabled: boolean; onSaved?(revision: number): void }) {
  const scope = useRef(0);
  const inFlight = useRef(false);
  const [id, setId] = useState(models[0] ?? "");
  const [data, setData] = useState<Result | null>(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState<Record<string,string>>({});
  const [pending,setPending] = useState(false);
  const [message,setMessage] = useState("");
  const [reload,setReload] = useState(0);
  useEffect(() => { setId((current) => models.includes(current) ? current : models[0] ?? ""); },[models]);
  useEffect(() => {
    let active = true; ++scope.current; inFlight.current = false; setPending(false); setData(null); setFailed(false);
    void workApi<Result>(`/v1/admin/work/provider-gateways/${encodeURIComponent(gatewayId)}/pricing`)
      .then((result) => { if (!result || !result.pricing || typeof result.pricing !== "object" || !Number.isSafeInteger(result.revision)) throw new Error("Invalid pricing response"); if (active) { setData(result); setMessage(""); } })
      .catch(() => { if(active) { setFailed(true); setMessage("Couldn't load pricing. Reload before saving."); } });
    return () => { active=false; ++scope.current; };
  },[gatewayId,reload]);
  useEffect(() => { const rates=data?.pricing?.[id.trim()]; setValues(Object.fromEntries(fields.map(([key])=>[key,rates?.[key]===undefined?"":String(rates[key])]))); },[data,id]);
  async function save(remove: boolean) {
    if (!data || inFlight.current || pending || disabled || !validWorkModelId(id.trim())) return;
    const previous = data.pricing[id.trim()];
    const rates: Rates = previous?.longContext ? { longContext: previous.longContext } : {};
    for (const [key] of fields) if (!remove && values[key]?.trim()) {
      const n = Number(values[key]);
      if (!Number.isFinite(n) || n<0 || n>1_000_000) { setMessage("Enter non-negative USD rates up to 1,000,000, or leave a rate blank when unknown."); return; }
      rates[key]=n;
    }
    if (!remove && rates.input === undefined && rates.output === undefined) { setMessage("Enter an input or output rate. Use 0 only for a known free rate."); return; }
    const admitted = scope.current;
    inFlight.current = true; setPending(true); setMessage("");
    try {
      const result=await workApi<Result>(`/v1/admin/work/provider-gateways/${encodeURIComponent(gatewayId)}/pricing`,{method:"POST",body:JSON.stringify({modelId:id.trim(),expectedRevision:data.revision,pricing:remove?null:{...rates,source:"configured",version:"configured",currency:"USD",unit:"perMillionTokens"}})});
      if (scope.current !== admitted) return;
      if (!result || !result.pricing || typeof result.pricing !== "object" || !Number.isSafeInteger(result.revision) || result.revision <= data.revision) throw new Error("Invalid save response");
      setData(result); onSaved?.(result.revision); setMessage(remove?"Provider pricing restored for future requests.":"Pricing saved for future requests. Historical costs are unchanged.");
    } catch { if (scope.current === admitted) { setFailed(true); setMessage("Pricing was not confirmed saved. Reload and review the values before retrying."); } }
    finally { if (scope.current === admitted) { inFlight.current = false; setPending(false); } }
  }
  const ready = !disabled && !pending && data !== null && validWorkModelId(id.trim());
  return <details className="group @container">
    <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm text-sm font-medium [&::-webkit-details-marker]:hidden">
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      Custom pricing
    </summary>
    <div className="space-y-3 pt-3">
      <p className="text-xs text-muted-foreground">Set negotiated rates in USD per 1M tokens. Blank means unknown; 0 means free.</p>
      {models.length === 0 ? <p className="text-xs text-muted-foreground">Allow a model to set its pricing.</p> : <>
        {models.length > 1 && <SearchSelect label="Model for custom pricing" searchPlaceholder="Search allowed models" value={id} disabled={disabled||pending} options={models.map((model)=>({value:model,label:model}))} onChange={setId} className="w-full @xl:w-80" />}
        <div className="grid grid-cols-2 gap-3 @xl:grid-cols-5">{fields.map(([key,label])=><label key={key} className="block min-w-0 space-y-1 text-xs text-muted-foreground">{label}<Input type="number" min="0" step="any" placeholder="Unknown" disabled={disabled||pending||!data} value={values[key]??""} onChange={(e)=>setValues(v=>({...v,[key]:e.target.value}))}/></label>)}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={!ready} onClick={()=>void save(false)}>{pending?"Saving…":"Save model pricing"}</Button>
          {data?.pricing[id.trim()] && <Button type="button" size="sm" variant="ghost" disabled={!ready} onClick={()=>void save(true)}>Use provider pricing</Button>}
          {failed && <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={()=>setReload(n=>n+1)}>Reload pricing</Button>}
        </div>
      </>}
      {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
    </div>
  </details>;
}
