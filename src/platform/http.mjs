/** Bound the actual bytes read, including chunked bodies and multibyte text. */
export async function readBody(request, limit) {
  const length = Number(request.headers.get('content-length'));
  if (length > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
