import { argon2id } from "./vendor/argon2.js";

export function validPassword(password: unknown): password is string {
  return typeof password === "string" && [...password].length >= 8 && [...password].length <= 128;
}

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

// Avoid allocating many simultaneous 19 MiB WASM heaps in one Worker isolate.
let hashing = Promise.resolve();
export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  const previous = hashing;
  let release!: () => void;
  hashing = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    return await argon2id({ password, salt, memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: "encoded" });
  } finally { release(); }
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19" || parts[3] !== "m=19456,t=2,p=1") return false;
  try {
    const salt = Uint8Array.from(atob(parts[4]!), c => c.charCodeAt(0));
    if (salt.length !== 16 || parts[5]!.length !== 43) return false;
    const actual = await hashPassword(password, salt);
    let mismatch = actual.length ^ encoded.length;
    for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ (encoded.charCodeAt(i) || 0);
    return mismatch === 0;
  } catch { return false; }
}
