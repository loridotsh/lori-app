import { cloudVisualSchema } from "./schema.js";

type Rule = { type?: string; enum?: readonly unknown[]; anyOf?: readonly Rule[]; required?: readonly string[]; properties?: Record<string, Rule>; items?: Rule };
function shape(rule: Rule): string {
  if (rule.anyOf) return rule.anyOf.map(shape).join(" | ");
  if (rule.enum) return rule.enum.map(value => JSON.stringify(value)).join(" | ");
  if (rule.type === "array") return `[${shape(rule.items!)}]`;
  if (rule.type === "object") return `{${Object.entries(rule.properties ?? {}).map(([key, value]) => `${key}${rule.required?.includes(key) ? "" : "?"}:${shape(value)}`).join(",")}}`;
  return rule.type ?? "unknown";
}
const catalog = cloudVisualSchema.properties.blocks.items;
const input = shape(cloudVisualSchema.properties.blocks.items.anyOf[3].properties.inputs.items);
const clock = shape(cloudVisualSchema.properties.blocks.items.anyOf[5].properties.timeline);
/** A compact provider schema avoids spending the context window on repeated control shapes. */
export const cloudVisualToolParameters: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["version", "title", "summary", "blocks"],
  properties: {
    version: { type: "integer", enum: [1] },
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 1200 },
    sources: cloudVisualSchema.properties.sources,
    blocks: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: true },
      description: `Shapes (? optional): Input=${input}; Clock=Input plus rate:number (units/real second, 1=real-time, max timeline 3600). ${shape(catalog).replaceAll(clock, "Clock").replaceAll(input, "Input")}. Formulas: input IDs, + - * / ^, min/max(a,b), abs/round/sin/cos/tan/sqrt/log/exp(a). Legacy postfix works. IDs unique; min<max; step>0; defaults in range. Charts <=40 labels/4 equal-length series. Tables <=100 rows/6 columns. Diagrams <=20 nodes/32 unique directed edges, existing IDs, no self edges. Mindmaps <=60 nodes, exactly one root without parentId, all other nodes reach it; no cycles; short labels, detail for explanation. Node IDs start with a letter, then letters/digits/_/-. Quizzes <=20 questions, unique options, zero-based answer index within options, optional hint and rationales (one per option explaining why it is right or wrong); flashcards <=30; timelines <=20. Slides <=20: layout title|section|statement|closing use title/subtitle/kicker; bullets, stats, columns and chart layouts require only their own field; headlines state the takeaway; notes hold sources and speaker detail. Reports <=12 sections; body is plain text: blank line between paragraphs, '- ' bullets, '1. ' steps, **bold**. Finite numbers only, magnitude <=1e12. No extra keys, URLs, HTML or code. Max 48 KiB total.`,
    },
  },
};
