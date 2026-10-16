/** Read exact bytes with a streaming ceiling; Content-Length is only an early hint. */
export async function readBoundedBytes(input: Request | Response, limit: number): Promise<Uint8Array | null> {
  if (Number(input.headers.get('content-length')) > limit) { await input.body?.cancel(); return null; }
  if (!input.body) return new Uint8Array();
  const reader = input.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
