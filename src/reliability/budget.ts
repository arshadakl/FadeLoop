export class WorkBudgetExceeded extends Error {
  constructor() { super('Invocation work budget exhausted'); }
}

/** Wrap the raw binding, outside the generation guard, so guard statements count too. */
export function budgetDatabase(db: D1Database, limit = 40): D1Database {
  const budget: QueryBudget = {limit,used:0,reserved:0,activeReserve:0,usingReserve:false};
  const originals = new WeakMap<object, D1PreparedStatement>();
  const charge = (count: number) => {
    if (budget.usingReserve) {
      if (count > budget.activeReserve) throw new WorkBudgetExceeded();
      budget.activeReserve -= count; budget.reserved -= count;
    } else if (budget.used + budget.reserved + count > limit) throw new WorkBudgetExceeded();
    budget.used += count;
  };
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
  budgets.set(proxy, budget);
  return proxy;
}
export interface QueryBudget { limit:number; used:number; reserved:number; activeReserve:number; usingReserve:boolean }
const budgets = new WeakMap<object, QueryBudget>();
/** Wrappers share the same invocation budget; never infer work allowance from proxy identity. */
export function shareQueryBudget(wrapper:D1Database,parent:D1Database):D1Database {
  const budget=budgets.get(parent);if(budget)budgets.set(wrapper,budget);return wrapper;
}
export function queryBudget(db:D1Database):QueryBudget|undefined{return budgets.get(db);}
export function remainingQueries(db: D1Database): number { const b=budgets.get(db);return b ? b.limit-b.used-b.reserved : Infinity; }
export interface QueryReservation { run<T>(fn:()=>Promise<T>):Promise<T>; release():void }
/** Reservation is scoped to this invocation. Do not run unrelated DB work concurrently with run(). */
export function reserveQueries(db:D1Database,count:number):QueryReservation|null {
  const b=budgets.get(db);
  if(!b)return {run:fn=>fn(),release(){}}; // Explicit unbudgeted unit-test adapters remain supported.
  if(count<=0||remainingQueries(db)<count)return null;
  b.reserved+=count;let left=count,active=false;
  return {
    async run(fn){
      if(active||b.usingReserve)throw new Error('Concurrent completion reservation');
      active=true;b.usingReserve=true;b.activeReserve=left;
      try{return await fn();}finally{left=b.activeReserve;b.activeReserve=0;b.usingReserve=false;active=false;}
    },
    release(){if(active)throw new Error('Cannot release an active reservation');b.reserved-=left;left=0;},
  };
}
