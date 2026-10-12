export class WorkBudgetExceeded extends Error {
  constructor() { super('Invocation work budget exhausted'); }
}

/** Wrap the raw binding, outside the generation guard, so guard statements count too. */
export function budgetDatabase(db: D1Database, limit = 40): D1Database {
  let used = 0;
  const originals = new WeakMap<object, D1PreparedStatement>();
  const charge = (count: number) => { if (used + count > limit) throw new WorkBudgetExceeded(); used += count; };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, { get(target, property) {
      if (property === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
      const value = Reflect.get(target, property);
      if (['run', 'first', 'all', 'raw'].includes(String(property))) return (...args: unknown[]) => {
        charge(1); return Reflect.apply(value, target, args);
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    originals.set(proxy, stmt); return proxy;
  };
  const proxy = new Proxy(db, { get(target, property) {
    if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
    if (property === 'batch') return (statements: D1PreparedStatement[]) => {
      charge(statements.length); return target.batch(statements.map(s => originals.get(s) ?? s));
    };
    if (property === 'exec') return () => { throw new Error('Use budgeted prepared statements'); };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  budgets.set(proxy, () => limit - used);
  return proxy;
}
const budgets = new WeakMap<object, () => number>();
export function remainingQueries(db: D1Database): number { return budgets.get(db)?.() ?? Infinity; }
