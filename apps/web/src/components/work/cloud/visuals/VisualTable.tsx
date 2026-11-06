"use client";

// Adapted from Lori Work; cloud visuals have no host or network actions.
import { useId, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { TableBlock } from "@lori-enterprise/contracts";
import { visualButton, visualIconButton } from "./ui";

const PAGE_SIZE = 8;

export function VisualTable({ block }: { block: TableBlock }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: number; descending: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const filtered = block.rows.map((cells, index) => ({ cells, index }))
      .filter(row => row.cells.some(cell => String(cell).toLocaleLowerCase().includes(search)));
    if (sort) filtered.sort((a, b) => {
      const left = a.cells[sort.column];
      const right = b.cells[sort.column];
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
      return (sort.descending ? -comparison : comparison) || a.index - b.index;
    });
    return filtered;
  }, [block.rows, query, sort]);
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const start = activePage * PAGE_SIZE;

  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Search {block.title}</span>
        <input value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} type="search" maxLength={300}
          className="w-full min-w-0 bg-transparent text-base sm:text-xs text-foreground outline-none placeholder:text-muted-foreground" placeholder="Filter rows…" aria-controls={id} />
      </label>
      {query && <button type="button" className={visualButton} onClick={() => { setQuery(""); setPage(0); }}>Clear filter</button>}
    </div>
    <div className="overflow-x-auto overscroll-x-contain rounded-lg border border-border/70 [scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent] focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label={`${block.title} table`}>
      <table id={id} className="w-full border-collapse text-left text-xs leading-5">
        <caption className="sr-only">{block.title}. Select a column heading to sort.</caption>
        <thead className="bg-secondary/60 text-muted-foreground"><tr>
          {block.columns.map((column, index) => <th key={index} scope="col" className="px-3 py-2 font-medium" aria-sort={sort?.column === index ? sort.descending ? "descending" : "ascending" : "none"}>
            <button type="button" className="inline-flex min-h-7 items-center gap-1.5 rounded text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
              setSort(current => ({ column: index, descending: current?.column === index ? !current.descending : false })); setPage(0);
            }}>
              <span className="[overflow-wrap:anywhere]">{column}</span>
              {sort?.column === index && (sort.descending ? <ArrowDown size={12} className="shrink-0" aria-hidden="true" /> : <ArrowUp size={12} className="shrink-0" aria-hidden="true" />)}
            </button>
          </th>)}
        </tr></thead>
        <tbody className="divide-y divide-border/60">
          {rows.slice(start, start + PAGE_SIZE).map(row => <tr key={row.index} className="hover:bg-secondary/40">
            {row.cells.map((cell, index) => <td key={index} className={`max-w-64 px-3 py-2.5 align-top [overflow-wrap:anywhere] ${typeof cell === "number" ? "tabular-nums" : ""}`}>{typeof cell === "number" ? cell.toLocaleString(undefined, { maximumSignificantDigits: 12 }) : cell}</td>)}
          </tr>)}
          {!rows.length && <tr><td colSpan={block.columns.length} className="px-3 py-7 text-center text-muted-foreground">No matching rows. Try another filter.</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
      <span role="status">{rows.length ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length} rows` : "0 rows"}</span>
      {rows.length > PAGE_SIZE && <div className="flex items-center gap-1">
        <button type="button" aria-label={`Previous page of ${block.title}`} className={visualIconButton} disabled={activePage === 0} onClick={() => setPage(activePage - 1)}><ChevronLeft size={15} aria-hidden="true" /></button>
        <span className="px-1 tabular-nums">{activePage + 1} / {lastPage + 1}</span>
        <button type="button" aria-label={`Next page of ${block.title}`} className={visualIconButton} disabled={activePage === lastPage} onClick={() => setPage(activePage + 1)}><ChevronRight size={15} aria-hidden="true" /></button>
      </div>}
    </div>
  </div>;
}
