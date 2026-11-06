// Adapted from Lori Work’s declarative visual catalog. Keep data-only and bounded.
import { cloudVisualSchema as schema } from "./schema.js";
import type { CalculatorInput, CloudVisual, Slide } from "./types.js";
import { calculate, binaryOperators as binary, unaryOperators as unary } from "./arithmetic.js";
export { calculate } from "./arithmetic.js";

export const MAX_VISUAL_BYTES = 48 * 1024;

type Schema = {
  type?: string; enum?: readonly unknown[]; anyOf?: readonly Schema[]; required?: readonly string[];
  properties?: Record<string, Schema | undefined>; items?: Schema;
  minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number;
};
const encoder = new TextEncoder();

function controlValues(inputs: CalculatorInput[]): Map<string, number> | null {
  const values = new Map<string, number>();
  for (const input of inputs) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(input.id) || binary.has(input.id) || unary.has(input.id)
      || !input.label.trim() || values.has(input.id) || input.min >= input.max || input.step > input.max - input.min
      || input.value < input.min || input.value > input.max) return null;
    values.set(input.id, input.value);
  }
  return values;
}

/** The closed subset of JSON Schema used by the server and browser catalog. */
function matches(rule: Schema, value: unknown): boolean {
  if (rule.anyOf) return rule.anyOf.some(option => matches(option, value));
  if (rule.enum && !rule.enum.includes(value)) return false;
  switch (rule.type) {
    case "string": return typeof value === "string" && !value.includes("\0")
      && (!(rule.minLength && rule.minLength > 0) || !!value.trim())
      && encoder.encode(value).length >= (rule.minLength ?? 0)
      && encoder.encode(value).length <= (rule.maxLength ?? 1048576);
    case "integer":
    case "number": return typeof value === "number" && Number.isFinite(value)
      && (rule.type !== "integer" || Number.isInteger(value))
      && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity);
    case "array": return Array.isArray(value) && value.length >= (rule.minItems ?? 0)
      && value.length <= (rule.maxItems ?? 200) && !!rule.items && value.every(item => matches(rule.items!, item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const object = value as Record<string, unknown>;
      return (rule.required ?? []).every(key => Object.hasOwn(object, key))
        && Object.entries(object).every(([key, item]) => Object.hasOwn(rule.properties ?? {}, key) && !!rule.properties?.[key] && matches(rule.properties[key]!, item));
    }
    default: return false;
  }
}

const slideContent = { bullets: "bullets", stats: "stats", columns: "columns", chart: "chart" } as const;

export function slideContentValid(slide: Slide): boolean {
  for (const [layout, field] of Object.entries(slideContent)) {
    if ((slide.layout === layout) !== (slide[field] !== undefined)) return false;
  }
  if (slide.chart) {
    const names = new Set(slide.chart.series.map(series => series.name));
    if (names.size !== slide.chart.series.length || slide.chart.series.some(series => series.values.length !== slide.chart!.labels.length)) return false;
  }
  return true;
}

export function parseVisual(value: unknown): CloudVisual | null {
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > MAX_VISUAL_BYTES || encoder.encode(encoded).length > MAX_VISUAL_BYTES
      || !matches(schema as Schema, value)) return null;
    const visual = value as CloudVisual;
    if (!visual.title.trim() || !visual.summary.trim()) return null;
    for (const block of visual.blocks) {
      if (!block.title.trim()) return null;
      if (block.type === "chart" && (new Set(block.series.map(series => series.name)).size !== block.series.length
        || block.series.some(series => series.values.length !== block.labels.length))) return null;
      if (block.type === "table" && (new Set(block.columns).size !== block.columns.length
        || block.rows.some(row => row.length !== block.columns.length))) return null;
      if (block.type === "diagram" || block.type === "mindmap") {
        const nodes = new Map(block.nodes.map(node => [node.id, node]));
        if (nodes.size !== block.nodes.length || block.nodes.some(node => !/^[A-Za-z][A-Za-z0-9_-]*$/.test(node.id) || !node.label.trim())) return null;
        if (block.type === "diagram") {
          const edges = new Set<string>();
          for (const edge of block.edges) {
            const key = JSON.stringify([edge.from, edge.to]);
            if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || edges.has(key)) return null;
            edges.add(key);
          }
        } else {
          if (block.nodes.filter(node => node.parentId === undefined).length !== 1) return null;
          const parents = new Map(block.nodes.map(node => [node.id, node.parentId]));
          for (const node of block.nodes) {
            const visited = new Set<string>([node.id]);
            let parent = node.parentId;
            while (parent !== undefined) {
              if (!nodes.has(parent) || visited.has(parent)) return null;
              visited.add(parent);
              parent = parents.get(parent);
            }
          }
        }
      }
      if (block.type === "quiz" && block.questions.some(question => question.answer >= question.options.length
        || new Set(question.options.map(option => option.trim())).size !== question.options.length
        || (question.rationales !== undefined && question.rationales.length !== question.options.length))) return null;
      if (block.type === "slides" && block.slides.some(slide => !slideContentValid(slide))) return null;
      if (block.type === "calculator" || block.type === "simulation") {
        const values = controlValues(block.type === "simulation" ? [...block.inputs, block.timeline] : block.inputs);
        if (!values || block.outputs.some(output => !output.label.trim() || calculate(output.expression, values) === null)) return null;
        if (block.type === "simulation") {
          const view = block.view;
          if (view.type === "track" ? view.min >= view.max : view.xMin >= view.xMax || view.yMin >= view.yMax) return null;
          if (new Set(view.items.map(item => item.label)).size !== view.items.length || view.items.some(item => !item.label.trim())) return null;
          for (const time of [block.timeline.min, block.timeline.value, block.timeline.max]) {
            values.set(block.timeline.id, time);
            if (block.outputs.some(output => calculate(output.expression, values) === null)
              || view.items.some(item => "expression" in item ? calculate(item.expression, values) === null
                : calculate(item.x, values) === null || calculate(item.y, values) === null)) return null;
          }
        }
      }
    }
    return visual;
  } catch { return null; }
}

export function visualText(visual: CloudVisual): string {
  return [visual.title, visual.summary, ...visual.blocks.map(block => {
    switch (block.type) {
      case "diagram": return `${block.title}\n${block.nodes.map(node => `${node.id}: ${node.label}${node.detail ? ` — ${node.detail}` : ""}`).join("\n")}\n${block.edges.map(edge => `${edge.from} → ${edge.to}${edge.label ? `: ${edge.label}` : ""}`).join("\n")}`;
      case "mindmap": return `${block.title}\n${block.nodes.map(node => `${node.parentId ? `${node.parentId} → ` : ""}${node.id}: ${node.label}${node.detail ? ` — ${node.detail}` : ""}`).join("\n")}`;
      case "timeline": return `${block.title}\n${block.items.map(item => `${item.label}: ${item.title}\n${item.text}`).join("\n\n")}`;
      case "quiz": return `${block.title} (includes answer key)\n${block.questions.map((question, index) => `${index + 1}. ${question.question}\n${question.options.map((option, i) => `${i + 1}) ${option}${question.rationales ? ` — ${question.rationales[i]}` : ""}`).join("\n")}\nAnswer: ${question.answer + 1}) ${question.options[question.answer]}\n${question.explanation}${question.hint ? `\nHint: ${question.hint}` : ""}`).join("\n\n")}`;
      case "flashcards": return `${block.title}\n${block.cards.map((card, index) => `${index + 1}. ${card.front}\n${card.back}`).join("\n\n")}`;
      case "slides": return `${block.title}\n${block.slides.map((slide, index) => [
        `Slide ${index + 1}: ${slide.kicker ? `${slide.kicker} · ` : ""}${slide.title}`,
        slide.subtitle,
        ...(slide.bullets ?? []).map(item => `• ${item}`),
        ...(slide.stats ?? []).map(item => `${item.value} — ${item.label}${item.detail ? ` (${item.detail})` : ""}`),
        ...(slide.columns ?? []).map(item => `${item.heading}: ${item.text}`),
        slide.chart && `${["", ...slide.chart.series.map(series => series.name)].join("\t")}\n${slide.chart.labels.map((label, i) => [label, ...slide.chart!.series.map(series => series.values[i])].join("\t")).join("\n")}${slide.chart.unit ? `\n(${slide.chart.unit})` : ""}`,
        slide.notes && `Notes: ${slide.notes}`,
      ].filter(Boolean).join("\n")).join("\n\n")}`;
      case "report": return `${block.title}\n${block.sections.map(section => `${section.heading}\n${section.body}`).join("\n\n")}`;
      case "chart": return `${block.title}\n${[block.xLabel, ...block.series.map(series => `${series.name} (${block.yLabel})`)].join("\t")}\n${block.labels.map((label, i) => [label, ...block.series.map(series => series.values[i])].join("\t")).join("\n")}`;
      case "table": return `${block.title}\n${[block.columns, ...block.rows].map(row => row.join("\t")).join("\n")}`;
      case "metrics": return `${block.title}\n${block.items.map(item => `${item.label}: ${item.value}${item.detail ? ` — ${item.detail}` : ""}`).join("\n")}`;
      case "steps": return `${block.title}\n${block.items.map((item, i) => `${i + 1}. ${item.title}\n${item.text}`).join("\n\n")}`;
      case "calculator":
      case "simulation": {
        const inputs = block.type === "simulation" ? [...block.inputs, block.timeline] : block.inputs;
        const values = new Map(inputs.map(input => [input.id, input.value]));
        return `${block.title} (default inputs)\n${inputs.map(input => `${input.label}: ${input.value} ${input.unit ?? ""}`.trim()).join("\n")}\n${block.outputs.map(output => `${output.label}: ${calculate(output.expression, values)} ${output.unit ?? ""}`.trim()).join("\n")}\n${block.note ?? ""}`;
      }
    }
  }), ...(visual.sources?.length ? ["Sources", ...visual.sources.map(source => `${source.label}: ${source.reference}`)] : [])].join("\n\n");
}
