import {readFileSync,readdirSync} from 'node:fs';
/** Preserve trigger bodies, which contain internal semicolons. Local disposable DBs only. */
export async function applyLocalMigrations(db){
 for(const file of readdirSync('schema').filter(f=>f.endsWith('.sql')).sort()){
  let statement='';
  for(const line of readFileSync(`schema/${file}`,'utf8').split(/\r?\n/)){
   const code=line.replace(/--.*$/,'').trim();if(!code)continue;
   statement+=`${code}\n`;
   if(!code.endsWith(';'))continue;
   if(/^CREATE TRIGGER/i.test(statement) && !/^END;$/i.test(code))continue;
   await db.prepare(statement).run();statement='';
  }
  if(statement.trim())throw new Error(`Incomplete migration ${file}`);
 }
}
