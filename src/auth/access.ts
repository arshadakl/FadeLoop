import type {Env} from '../types';
import {readBoundedBytes} from '../routes/body';

export class AccessConfigurationError extends Error {}
export function ownerAuthMode(env: Env): 'password' | 'access' {
  const mode = env.AUTH_MODE ?? 'password';
  if (mode !== 'password' && mode !== 'access') throw new AccessConfigurationError('Invalid AUTH_MODE');
  return mode;
}
export interface AccessIdentity { email: string; sub: string; exp: number; iat: number; auth_time?: number }
interface Claims extends AccessIdentity { iss: string; aud: string[] | string; nbf?: number; type?: string }
type SigningJwk = JsonWebKey & {kid?: string; alg?: string; use?: string};
interface Keys { expires: number; fetched: number; keys: Map<string, CryptoKey> }
// Resolved CryptoKeys only: do not share request-owned fetch promises between invocations.
const keyCache = new Map<string, Keys>();
const decoder = new TextDecoder('utf-8', {fatal: true,ignoreBOM:false}), encoder = new TextEncoder();
function configuration(env: Env, action: boolean) {
  const issuer = env.ACCESS_ISSUER, audience = action ? env.ACCESS_ACTION_AUDIENCE : env.ACCESS_AUDIENCE;
  if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || audience.length > 256)
    throw new AccessConfigurationError('Configure ACCESS_ISSUER and the Access application audience');
  return {issuer, audience};
}
function decode(part: string): Uint8Array {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid token encoding');
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
async function signingKeys(issuer: string, kid: string, now: number): Promise<Map<string, CryptoKey>> {
  const cached = keyCache.get(issuer);
  if (cached && cached.expires > now && (cached.keys.has(kid) || now - cached.fetched < 30)) return cached.keys;
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {signal: AbortSignal.timeout(5000), redirect: 'error'});
  if (!response.ok) { await response.body?.cancel(); throw new Error('Access keys unavailable'); }
  const bytes = await readBoundedBytes(response, 64 * 1024);
  if (!bytes) throw new Error('Access key response too large');
  const document = JSON.parse(decoder.decode(bytes)) as {keys?: SigningJwk[]};
  if (!Array.isArray(document.keys) || document.keys.length > 16) throw new Error('Invalid Access key set');
  const keys = new Map<string, CryptoKey>();
  for (const jwk of document.keys) {
    if (jwk.kty !== 'RSA' || !jwk.kid || jwk.kid.length > 256 || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, {name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'}, false, ['verify']));
  }
  if (!keys.size) throw new Error('No Access signing keys');
  if (keyCache.size >= 2 && !keyCache.has(issuer)) keyCache.delete(keyCache.keys().next().value!);
  keyCache.set(issuer, {keys, fetched:now, expires:now+300}); return keys;
}

/** Validate the assertion independently of edge routing, including alternate hostnames. */
export async function verifyAccess(req: Request, env: Env, action = false): Promise<AccessIdentity | null> {
  const {issuer, audience} = configuration(env, action);
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > 16 * 1024) return null;
  try {
    const parts = token.split('.'); if (parts.length !== 3) return null;
    const [head, payload, signature] = parts as [string,string,string];
    const header = JSON.parse(decoder.decode(decode(head))) as {alg?:string;kid?:string;crit?:unknown};
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 256 || header.crit !== undefined) return null;
    const claims = JSON.parse(decoder.decode(decode(payload))) as Claims;
    const now = Math.floor(Date.now()/1000);
    if (!claims || claims.iss !== issuer || !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now+30 || claims.iat >= claims.exp) return null;
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience) || typeof claims.email !== 'string' || claims.email.length > 254 || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256) return null;
    if (env.ACCESS_OWNER_SUBJECT && claims.sub !== env.ACCESS_OWNER_SUBJECT) return null;
    // A newly minted JWT is not fresh authentication. Destructive routes require signed auth_time.
    if (action && (!Number.isSafeInteger(claims.auth_time) || claims.auth_time! > now || now-claims.auth_time! > 300)) return null;
    const key = (await signingKeys(issuer, header.kid, now)).get(header.kid);
    if (!key || !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(signature), encoder.encode(`${head}.${payload}`))) return null;
    return {email:claims.email.trim().toLowerCase(),sub:claims.sub,exp:claims.exp,iat:claims.iat,...(claims.auth_time === undefined ? {} : {auth_time:claims.auth_time})};
  } catch { return null; }
}
