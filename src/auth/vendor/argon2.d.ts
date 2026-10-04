export function argon2id(options: {
  password: string; salt: Uint8Array; memorySize: number; iterations: number;
  parallelism: number; hashLength: number; outputType: "encoded";
}): Promise<string>;
