"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, Circle, CircleDot, ListTodo } from "lucide-react";
import type { TodoList } from "@lori-enterprise/contracts";

/** Display saved task state; disclosure preferences are local to the current plan. */
export function TodoChecklist({ list, working = false }: { list: TodoList; working?: boolean }) {
  const id = useId();
  const completed = list.todos.filter(todo => todo.status === "completed").length;
  const ids = list.todos.map(todo => todo.id);
  const identity = JSON.stringify(ids);
  const [disclosure, setDisclosure] = useState(() => ({ identity, ids, open: completed < ids.length }));
  const [reveal, setReveal] = useState(false);
  // Keep the user's choice through progress, reordering and additions. A wholly
  // replaced plan (including clear -> recreate) gets its own initial state.
  let open = disclosure.open;
  if (disclosure.identity !== identity) {
    open = ids.some(item => disclosure.ids.includes(item)) ? disclosure.open : completed < ids.length;
    setDisclosure({ identity, ids, open });
  }
  if (!ids.length) return <p className="my-3 text-xs text-muted-foreground" role="status">Tasks cleared</p>;
  return <section aria-label="Task progress" className="my-2 min-w-0 text-[13px] leading-5">
    <button type="button" aria-expanded={open} aria-controls={id}
      aria-label={`Tasks, ${completed} of ${ids.length} completed`}
      onClick={() => { setReveal(!open); setDisclosure({ identity, ids, open: !open }); }}
      className="flex min-h-8 w-fit max-w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-start text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-muted-foreground">
      <ListTodo size={14} strokeWidth={1.7} aria-hidden className="shrink-0" />
      <span>Tasks</span>
      <span aria-hidden="true" className="shrink-0 text-xs tabular-nums text-muted-foreground">{completed}/{ids.length}</span>
      <ChevronDown size={12} aria-hidden className={`shrink-0 text-muted-foreground transition-transform ${open ? "" : "-rotate-90"}`} />
    </button>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{completed} of {ids.length} tasks completed.</span>
    <div id={id} hidden={!open}>
      <ol role="list" className={`m-0 list-none space-y-0.5 py-0.5 ps-7 pe-1.5 ${reveal ? "motion-safe:animate-reveal" : ""}`}>
        {list.todos.map(todo => {
          const done = todo.status === "completed";
          const active = todo.status === "in_progress" && working;
          const Icon = done ? Check : active ? CircleDot : Circle;
          return <li key={todo.id} className="flex min-h-6 min-w-0 items-start gap-2 py-0.5">
            <Icon size={13} aria-hidden className={`mt-1 shrink-0 ${active ? "text-foreground" : "text-muted-foreground"}`} />
            <span dir="auto" className={`min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] ${done ? "text-muted-foreground" : active ? "font-medium text-foreground" : "text-muted-foreground"}`}>
              <span className="sr-only">{done ? "Completed: " : active ? "In progress: " : "Pending: "}</span>{todo.content}
            </span>
          </li>;
        })}
      </ol>
    </div>
  </section>;
}
