import type { LucideIcon } from "lucide-react";
import { BarChart3, BookOpenText, Calculator, Clock3, GalleryHorizontalEnd, Gauge, Layers, ListChecks, ListOrdered, Network, Orbit, Presentation, Table2, Workflow } from "lucide-react";
import type { CloudVisual, VisualBlock } from "@lori-enterprise/contracts";

export const immersiveBlocks = new Set<VisualBlock["type"]>(["mindmap", "quiz", "flashcards", "slides", "report"]);

const kinds: Record<VisualBlock["type"], { label: string; icon: LucideIcon }> = {
  mindmap: { label: "Mind map", icon: Network },
  quiz: { label: "Quiz", icon: ListChecks },
  flashcards: { label: "Flashcards", icon: GalleryHorizontalEnd },
  slides: { label: "Slide deck", icon: Presentation },
  report: { label: "Report", icon: BookOpenText },
  diagram: { label: "Diagram", icon: Workflow },
  timeline: { label: "Timeline", icon: Clock3 },
  chart: { label: "Chart", icon: BarChart3 },
  table: { label: "Data table", icon: Table2 },
  calculator: { label: "Calculator", icon: Calculator },
  simulation: { label: "Simulation", icon: Orbit },
  steps: { label: "Steps", icon: ListOrdered },
  metrics: { label: "Key figures", icon: Gauge },
};

function count(block: VisualBlock): string {
  const plural = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
  switch (block.type) {
    case "mindmap": return plural(block.nodes.length, "topic");
    case "quiz": return plural(block.questions.length, "question");
    case "flashcards": return plural(block.cards.length, "card");
    case "slides": return plural(block.slides.length, "slide");
    case "report": return plural(block.sections.length, "section");
    case "timeline": return plural(block.items.length, "event");
    case "steps": return plural(block.items.length, "step");
    case "table": return plural(block.rows.length, "row");
    case "diagram": return plural(block.nodes.length, "node");
    default: return "";
  }
}

export function visualKind(visual: CloudVisual): { label: string; detail: string; icon: LucideIcon; immersive: boolean } {
  if (visual.blocks.length === 1) {
    const block = visual.blocks[0]!;
    return { ...kinds[block.type], detail: count(block), immersive: immersiveBlocks.has(block.type) };
  }
  return { label: "Artifact", detail: `${visual.blocks.length} parts`, icon: Layers, immersive: false };
}
