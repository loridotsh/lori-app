// Adapted from Lori Work’s declarative visual catalog. Keep data-only and bounded.
export interface ChartBlock {
  type: "chart";
  title: string;
  chartType: "bar" | "line";
  xLabel: string;
  yLabel: string;
  labels: string[];
  series: { name: string; values: number[] }[];
}
export interface TableBlock {
  type: "table";
  title: string;
  columns: string[];
  rows: (string | number)[][];
}
export interface CalculatorInput {
  id: string; label: string; min: number; max: number; step: number; value: number; unit?: string;
}
export interface VisualOutput {
  label: string; expression: string | (number | string)[]; unit?: string; precision?: number;
}
export interface CalculatorBlock {
  type: "calculator";
  title: string;
  inputs: CalculatorInput[];
  outputs: VisualOutput[];
  note?: string;
}
export type SimulationView =
  | { type: "track"; label: string; min: number; max: number; unit?: string; items: { label: string; expression: string }[] }
  | { type: "plane"; xLabel: string; yLabel: string; xMin: number; xMax: number; yMin: number; yMax: number; items: { label: string; x: string; y: string }[] };
export interface SimulationBlock {
  type: "simulation";
  title: string;
  inputs: CalculatorInput[];
  timeline: CalculatorInput & { rate: number };
  outputs: VisualOutput[];
  view: SimulationView;
  note?: string;
}
export interface StepsBlock {
  type: "steps";
  title: string;
  items: { title: string; text: string }[];
}
export interface MetricsBlock {
  type: "metrics";
  title: string;
  items: { label: string; value: string; detail?: string }[];
}
export interface DiagramBlock {
  type: "diagram";
  title: string;
  direction: "down" | "right";
  nodes: { id: string; label: string; detail?: string }[];
  edges: { from: string; to: string; label?: string }[];
}
export interface MindmapBlock {
  type: "mindmap";
  title: string;
  nodes: { id: string; label: string; parentId?: string; detail?: string }[];
}
export interface TimelineBlock {
  type: "timeline";
  title: string;
  items: { label: string; title: string; text: string }[];
}
export interface QuizBlock {
  type: "quiz";
  title: string;
  questions: { question: string; options: string[]; answer: number; explanation: string; hint?: string; rationales?: string[] }[];
}
export interface FlashcardsBlock {
  type: "flashcards";
  title: string;
  cards: { front: string; back: string }[];
}
export type SlideLayout = "title" | "section" | "bullets" | "statement" | "stats" | "columns" | "chart" | "closing";
export interface Slide {
  layout: SlideLayout;
  title: string;
  kicker?: string;
  subtitle?: string;
  bullets?: string[];
  stats?: { value: string; label: string; detail?: string }[];
  columns?: { heading: string; text: string }[];
  chart?: { chartType: "bar" | "line"; labels: string[]; series: { name: string; values: number[] }[]; unit?: string };
  notes?: string;
}
export interface SlidesBlock {
  type: "slides";
  title: string;
  slides: Slide[];
}
export interface ReportBlock {
  type: "report";
  title: string;
  sections: { heading: string; body: string }[];
}
export type VisualBlock = ChartBlock | TableBlock | CalculatorBlock | StepsBlock | MetricsBlock | SimulationBlock | DiagramBlock | MindmapBlock | TimelineBlock | QuizBlock | FlashcardsBlock | SlidesBlock | ReportBlock;
export interface CloudVisual {
  version: 1;
  title: string;
  summary: string;
  blocks: VisualBlock[];
  sources?: { label: string; reference: string }[];
}
