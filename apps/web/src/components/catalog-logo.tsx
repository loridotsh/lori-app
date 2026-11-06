"use client";

import { useState } from "react";
import {
  BookOpenIcon,
  CalendarDaysIcon,
  FileTextIcon,
  FolderKanbanIcon,
  NotebookPenIcon,
  PresentationIcon,
  SearchIcon,
  SheetIcon,
  PlugIcon,
  ServerIcon,
} from "lucide-react";

const plugins: Record<string, string> = {
  notion: "notion.svg",
  linear: "linear.svg",
  github: "github.svg",
  slack: "slack.png",
  asana: "asana.svg",
  clickup: "clickup.png",
  miro: "miro.svg",
  intercom: "intercom.svg",
  sentry: "sentry.svg",
  exa: "exa.svg",
};
const providers: Record<string, string> = {
  "0g": "0g.png",
  openai: "openai.png",
  anthropic: "anthropic.png",
  google: "google.svg",
  openrouter: "openrouter.svg",
  groq: "groq.png",
  mistral: "mistral.png",
  together: "together.png",
  fireworks: "fireworks.png",
  akashml: "akashml.png",
  venice: "venice.png",
  ollama: "ollama.png",
  vllm: "vllm.png",
};
const skills = {
  research: SearchIcon,
  documents: FileTextIcon,
  spreadsheets: SheetIcon,
  presentations: PresentationIcon,
  pdfs: FileTextIcon,
  "meeting-preparation": CalendarDaysIcon,
  "knowledge-capture": NotebookPenIcon,
  "project-planning": FolderKanbanIcon,
};

/** Bundled assets only. Adjacent catalog text supplies the accessible name. */
const sizes = {
  xs: {
    box: "size-5 rounded",
    image: "size-3.5",
    pixels: 14,
    icon: "size-3.5",
  },
  sm: { box: "size-8 rounded-md", image: "size-5", pixels: 20, icon: "size-4" },
  md: {
    box: "size-10 rounded-lg",
    image: "size-6",
    pixels: 24,
    icon: "size-5",
  },
  lg: {
    box: "size-14 rounded-xl",
    image: "size-8",
    pixels: 32,
    icon: "size-7",
  },
} as const;

export function CatalogLogo({
  id,
  type,
  size = "md",
}: {
  id: string;
  type: string;
  size?: keyof typeof sizes;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const dimensions = sizes[size];
  const file =
    type === "provider"
      ? providers[id]
      : type === "skill"
        ? undefined
        : plugins[id];
  const src = file
    ? `/catalog-logos/${type === "provider" ? "provider-" : ""}${file}`
    : undefined;
  const Icon =
    type === "skill"
      ? (skills[id as keyof typeof skills] ?? BookOpenIcon)
      : type === "provider"
        ? ServerIcon
        : PlugIcon;
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center border ${dimensions.box} ${src && failed !== src ? "border-black/10 bg-white" : "border-border bg-secondary text-muted-foreground"}`}
    >
      {src && failed !== src ? (
        // Small, local brand assets need no remote image optimizer.
        <img
          src={src}
          alt=""
          width={dimensions.pixels}
          height={dimensions.pixels}
          className={`${dimensions.image} object-contain`}
          onError={() => setFailed(src)}
        />
      ) : (
        <Icon className={dimensions.icon} strokeWidth={1.6} />
      )}
    </span>
  );
}
