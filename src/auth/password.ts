// Password hashing is intentionally expensive. Native WebCrypto is not a Free CPU-budget guarantee.
// Backwards-compatible verification for existing $argon2id$ hashes with automatic upgrade.
import { argon2id } from "./vendor/argon2.js";

export function validPassword(password: unknown): password is string {
  return typeof password === "string" && [...password].length >= 8 && [...password].length <= 128;
}

export function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(
  password: string,
  salt = crypto.getRandomValues(new Uint8Array(16))
): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("");
  const hashHex = Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // Node.js crypto.timingSafeEqual
  const g = globalThis as unknown as { crypto?: { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean } };
  if (typeof g.crypto?.timingSafeEqual === "function") {
    return g.crypto.timingSafeEqual(a, b);
  }
  // Constant-time XOR loop for environments without timingSafeEqual
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i]! ^ b[i]!;
  }
  return mismatch === 0;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (typeof encoded !== "string") return false;

  // Modern native PBKDF2 format: pbkdf2$iterations$saltHex$hashHex
  if (encoded.startsWith("pbkdf2$")) {
    const parts = encoded.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number(parts[1]);
    const saltHex = parts[2]!;
    const expectedHashHex = parts[3]!;
    if (!Number.isFinite(iterations) || iterations < 10_000 || saltHex.length !== 32 || expectedHashHex.length !== 64) {
      return false;
    }
    const salt = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      salt[i] = parseInt(saltHex.slice(i * 2, i * 2 + 2), 16);
    }
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const hashBuffer = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );
    const actualHash = new Uint8Array(hashBuffer);
    const expectedHash = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      expectedHash[i] = parseInt(expectedHashHex.slice(i * 2, i * 2 + 2), 16);
    }
    return constantTimeCompare(actualHash, expectedHash);
  }

  // Backwards compatibility for existing Argon2id hashes: $argon2id$v=19$m=19456,t=2,p=1$...
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19" || parts[3] !== "m=19456,t=2,p=1") return false;
  try {
    const salt = Uint8Array.from(atob(parts[4]!), (c) => c.charCodeAt(0));
    if (salt.length !== 16 || parts[5]!.length !== 43) return false;
    const actual = await argon2id({ password, salt, memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: "encoded" });
    if (actual.length !== encoded.length) return false;
    const enc = new TextEncoder();
    const actualBytes = enc.encode(actual);
    const encodedBytes = enc.encode(encoded);
    return constantTimeCompare(actualBytes, encodedBytes);
  } catch {
    return false;
  }
}

