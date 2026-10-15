/** Bound bytes while reading, including chunked requests without Content-Length. */
export class PosPayloadTooLarge extends Error {}
export async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (declaredLength > maximumBytes) throw new PosPayloadTooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new PosPayloadTooLarge()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(joined)
}
