/** Both hosted modes keep every legacy route and Server Action inaccessible. */
export function publicReleaseAccess(
  path: string,
  method: string,
  onlinePilot = false
): 'allow' | 'not_found' | 'unavailable' {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/pos/health') return read ? 'allow' : 'not_found'
  // Previously issued device evidence must remain recoverable when new selling is paused.
  if (path === '/api/pos/offline/import' || path === '/api/pos/offline/seal')
    return method === 'POST' ? 'allow' : 'not_found'
  if (onlinePilot) {
    if (
      (path === '/counter' ||
        path === '/counter/' ||
        path === '/billing' ||
        path === '/billing/' ||
        path === '/staff/accept' ||
        path === '/staff/accept/') &&
      read
    )
      return 'allow'
    const apiMethods: Record<string, string[]> = {
      '/api/pos/native/access': ['GET'],
      '/api/pos/native/device': ['POST'],
      '/api/pos/offline/enroll': ['POST'],
      '/api/pos/offline/authority': ['POST'],
      '/api/billing/paypal/status': ['GET'],
      '/api/billing/paypal/checkout': ['POST'],
      '/api/billing/paypal/reconcile': ['POST'],
      '/api/billing/paypal/cancel': ['POST'],
      '/api/billing/paypal/webhook': ['POST'],
      '/api/pos/session': ['GET', 'POST', 'DELETE'],
      '/api/pos/catalogue': ['GET', 'POST'],
      '/api/pos/offers': ['GET', 'POST'],
      '/api/pos/kitchen': ['GET', 'POST'],
      '/api/pos/kitchen/recovery': ['POST'],
      '/api/pos/tab-kitchen': ['GET', 'POST'],
      '/api/pos/tab-kitchen/recovery': ['POST'],
      '/api/pos/open-orders': ['GET', 'POST'],
      '/api/pos/open-orders/recovery': ['POST'],
      '/api/pos/staff': ['GET', 'POST'],
      '/api/pos/staff/invitations': ['POST'],
      '/api/pos/staff/recovery': ['POST'],
      '/api/pos/staff/invitations/revoke': ['POST'],
      '/api/pos/staff/invitations/accept': ['POST'],
      '/api/pos/account/password': ['POST'],
      '/api/pos/offers/quote': ['POST'],
      '/api/pos/bootstrap': ['GET'],
      '/api/pos/receipts': ['GET'],
      '/api/pos/reports': ['GET'],
      '/api/pos/recovery': ['POST'],
      '/api/pos/devices': ['POST'],
      '/api/pos/sync': ['POST'],
      '/api/pos/commands': ['POST'],
    }
    if (apiMethods[path]?.includes(method)) return 'allow'
  }
  if (path.startsWith('/api/pos/')) return 'unavailable'
  if (!read) return 'not_found'
  if (
    [
      '/',
      '/pos',
      '/pos/',
      '/pos.webmanifest',
      '/pos-sw.js',
      '/pos-icon.svg',
      '/pos-share.png',
      '/pos-share.svg',
    ].includes(path)
  )
    return 'allow'
  if (path.startsWith('/_next/static/') || path.startsWith('/pos-assets/')) return 'allow'
  return 'not_found'
}
