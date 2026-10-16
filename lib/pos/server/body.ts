/** Bound bytes while reading, including chunked requests without Content-Length. */
export class PosPayloadTooLarge extends Error {}
export class PosBodyReadTimeout extends Error {}
export async function readBoundedBytes(request: Request, maximumBytes: number, timeoutMs?: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length') || 0)
  if (declaredLength > maximumBytes) throw new PosPayloadTooLarge()
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = timeoutMs ? new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new PosBodyReadTimeout()); void reader.cancel().catch(() => {}) }, timeoutMs)
  }) : null
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read())
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        // Cancellation is best effort; a hostile stream must not retain a bounded upload slot.
        void reader.cancel().catch(() => {})
        throw new PosPayloadTooLarge()
      }
      chunks.push(value)
    }
  } finally { clearTimeout(timer); reader.releaseLock() }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
  return joined
}
export async function readBoundedBody(request: Request, maximumBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBytes(request, maximumBytes))
}
