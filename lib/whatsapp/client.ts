export async function sendText(args: {
  phoneNumberId: string
  accessToken: string
  to: string
  body: string
}) {
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${args.phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: args.to,
        type: 'text',
        text: { body: args.body },
      }),
    },
  )
  if (!res.ok) throw new Error(`WA ${res.status}: ${await res.text()}`)
  return res.json()
}
