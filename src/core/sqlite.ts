import type { Database, SQLQueryBindings } from "bun:sqlite";

/** Bun 1.4's checked Database.run contract takes one binding array. */
export function runSql(
  db: Database,
  sql: string,
  ...bindings: SQLQueryBindings[]
): ReturnType<Database["run"]>;
export function runSql(
  db: Database,
  sql: string,
  bindings: SQLQueryBindings[],
): ReturnType<Database["run"]>;
export function runSql(
  db: Database,
  sql: string,
  ...bindings: SQLQueryBindings[] | [SQLQueryBindings[]]
): ReturnType<Database["run"]> {
  const normalized = bindings.length === 1 && Array.isArray(bindings[0])
    ? bindings[0]
    : bindings as SQLQueryBindings[];
  return db.run(sql, normalized);
}
