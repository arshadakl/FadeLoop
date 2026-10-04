/** A generation scopes every Instagram-dependent mutation to one connection lifetime. */
export class ConnectionChangedError extends Error {
  constructor() { super("Instagram connection changed. Refresh and try again."); }
}
export async function connectionGeneration(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT generation FROM instagram_connection_state WHERE id = 1").first<{ generation: number }>();
  if (!row) throw new Error("Instagram connection migration is required");
  return row.generation;
}
export async function assertConnection(db: D1Database, generation: number): Promise<void> {
  const row = await db.prepare(`SELECT 1 AS valid FROM instagram_connection_state
    WHERE id = 1 AND generation = ? AND EXISTS (SELECT 1 FROM auth WHERE id = 1)`).bind(generation).first();
  if (!row) throw new ConnectionChangedError();
}
// The CHECK constraint deliberately aborts the entire D1 transaction on a stale generation.
// A check-then-write outside the batch would allow a disconnect between the two operations.
export function connectionGuard(db: D1Database, generation: number, connected = true): D1PreparedStatement {
  return db.prepare(`UPDATE instagram_connection_state SET generation = CASE
    WHEN generation = ? ${connected ? "AND EXISTS (SELECT 1 FROM auth WHERE id = 1)" : ""}
    THEN generation ELSE -1 END WHERE id = 1`).bind(generation);
}
export function guardedConnectionDb(db: D1Database, generation: number): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  async function batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    try {
      const result = await db.batch<T>([connectionGuard(db, generation), ...statements.map(s => originals.get(s) ?? s)]);
      return result.slice(1);
    } catch (error) {
      await assertConnection(db, generation);
      throw error;
    }
  }
  function wrap(statement: D1PreparedStatement, mutation: boolean): D1PreparedStatement {
    const proxy = new Proxy(statement, { get(target, property) {
      if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), mutation);
      if (mutation && ["run", "all", "first", "raw"].includes(String(property))) return async () => {
        if (property === "raw") throw new Error("Mutation raw() is unsupported");
        const result = (await batch([target]))[0]!;
        if (property === "first") return result.results?.[0] ?? null;
        return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    originals.set(proxy, statement);
    return proxy;
  }
  return new Proxy(db, { get(target, property) {
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));
    if (property === "batch") return batch;
    if (property === "exec") return () => { throw new Error("Use prepared statements for connection-scoped writes"); };
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
