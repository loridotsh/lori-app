import type { PoolClient } from "pg";
import { parseTodoList, type TodoList } from "@lori-enterprise/contracts";
import { IdentityError } from "../auth/identity-service.js";
import { readContent } from "./projects/records.js";

/** Call only after owning the conversation/run and entering its project scope. */
export async function currentTodos(c: PoolClient, conversationId: string): Promise<TodoList> {
  const result = await readContent(c, "tool", c.query(
    "SELECT t.id,t.output,t.todo_revision FROM cloud_work_tool_invocations t JOIN cloud_work_runs r ON r.id=t.run_id WHERE r.conversation_id=$1 AND t.name='write_todos' AND t.status='completed' AND t.todo_revision IS NOT NULL ORDER BY t.todo_revision DESC LIMIT 1",
    [conversationId],
  ));
  const row = result.rows[0];
  if (!row) return { revision: 0, todos: [] };
  const list = parseTodoList(row.output?.todoList);
  if (!list || list.revision !== Number(row.todo_revision))
    throw new IdentityError(409, "cloud_todo_state_invalid", "The saved todo list could not be read. Your execution history is preserved.");
  return list;
}
