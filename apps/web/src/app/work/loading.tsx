export default function WorkLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-auto w-full max-w-5xl space-y-6 px-5 py-10 sm:px-8"
    >
      <span className="sr-only">Loading Work settings…</span>
      <div aria-hidden className="space-y-3">
        <div className="h-7 w-40 rounded bg-muted motion-safe:animate-pulse" />
        <div className="h-4 w-3/4 max-w-xl rounded bg-muted motion-safe:animate-pulse" />
      </div>
      <div aria-hidden className="h-12 border-b border-border" />
      <div
        aria-hidden
        className="divide-y divide-border rounded-lg border border-border"
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className="space-y-3 p-5">
            <div className="h-4 w-40 rounded bg-muted motion-safe:animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  );
}
