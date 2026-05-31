const BASE = 'https://api.printnode.com'

export async function sendPrint(printerId: number, raw: string, title = 'SmartPOS ticket') {
  const auth = Buffer.from(process.env.PRINTNODE_API_KEY + ':').toString('base64')
  const res = await fetch(`${BASE}/printjobs`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      printerId,
      title,
      contentType: 'raw_base64',
      content: Buffer.from(raw).toString('base64'),
      source: 'SmartPOS.ai',
    }),
  })
  if (!res.ok) throw new Error(`PrintNode ${res.status}: ${await res.text()}`)
  return await res.json()
}
