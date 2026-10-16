import type {Env} from '../types';
import {getSession, type OwnerSession} from './session';
import {ownerAuthMode, verifyAccess} from './access';

/** Public OAuth callbacks deliberately retain their session-bound state validation. */
export async function getOwnerSession(req: Request, env: Env): Promise<OwnerSession | null> {
  if (ownerAuthMode(env) === 'password') return getSession(req, env.DB);
  let identity = await verifyAccess(req, env);
  if (!identity && env.ACCESS_ACTION_AUDIENCE && new URL(req.url).pathname === '/auth/disconnect') identity = await verifyAccess(req,env,true);
  if (!identity) return null;
  const session = await getSession(req, env.DB);
  return session?.email.trim().toLowerCase() === identity.email ? session : null;
}
