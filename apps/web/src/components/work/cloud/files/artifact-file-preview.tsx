import { lazy, Suspense } from "react";
import type { CloudVisual } from "@lori-enterprise/contracts";

const VisualDocument = lazy(() => import("../visuals/visual-activity").then(module => ({
  default: ({ visual, ...props }: { visual: CloudVisual; canExport: boolean }) =>
    <module.VisualBoundary summary={visual.summary}><module.VisualDocument visual={visual} {...props} layout="stage" showTitle={false} /></module.VisualBoundary>,
})));

export function ArtifactFilePreview({ visual, canExport }: { visual: CloudVisual | null; canExport: boolean }) {
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-4 pt-3 pb-4 sm:px-5">
    {visual ? <Suspense fallback={<p role="status" className="py-4 text-xs text-muted-foreground">Loading artifact…</p>}>
      <VisualDocument visual={visual} canExport={canExport} />
    </Suspense> : <p role="status" className="py-4 text-xs leading-5 text-muted-foreground">This artifact is invalid or exceeds the preview limits. Open Edit to inspect it, or ask Lori to repair it.</p>}
  </div>;
}
