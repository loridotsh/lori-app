// Generated from Lori src/work/tasks/model.ts. Regenerate with vendor-work-catalog.mjs.
/** Conversation-scoped planning data. Checked items are agent claims, not receipts. */
export interface Todo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export interface TodoList { revision: number; todos: Todo[] }
export interface WriteTodos { expectedRevision: number; todos: Todo[] }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function parseTodoList(value: unknown): TodoList | null {
  if (!object(value) || Object.keys(value).some(key => !["revision", "todos"].includes(key)) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !Array.isArray(value.todos) || value.todos.length > 20) return null;
  const ids = new Set<string>();
  let active = 0;
  const todos: Todo[] = [];
  for (const item of value.todos) {
    if (!object(item) || Object.keys(item).some(key => !["id", "content", "status"].includes(key)) ||
        typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || ids.has(item.id) ||
        typeof item.content !== "string" || !item.content.trim() || item.content.includes("\0") ||
        new TextEncoder().encode(item.content).length > 240 ||
        typeof item.status !== "string" || !["pending", "in_progress", "completed"].includes(item.status)) return null;
    ids.add(item.id);
    if (item.status === "in_progress") active++;
    todos.push({ id: item.id, content: item.content, status: item.status as Todo["status"] });
  }
  if (active > 1 || bytes(value) > 6144) return null;
  return { revision: Number(value.revision), todos };
}
export function parseTodoWrite(value: unknown): WriteTodos | null {
  if (!object(value) || Object.keys(value).some(key => !["expectedRevision", "todos"].includes(key)) ||
      !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER) return null;
  const list = parseTodoList({ revision: value.expectedRevision, todos: value.todos });
  return list && bytes(value) <= 6144 ? { expectedRevision: list.revision, todos: list.todos } : null;
}
export function todoListFromOutput(output: unknown): TodoList | null {
  return object(output) ? parseTodoList(output.todoList) : null;
}
