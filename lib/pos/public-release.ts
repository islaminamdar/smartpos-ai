/** Both hosted modes keep every legacy route and Server Action inaccessible. */
export function publicReleaseAccess(path: string, method: string, onlinePilot = false): 'allow' | 'not_found' | 'unavailable' {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/pos/health') return read ? 'allow' : 'not_found'
  if (onlinePilot) {
    if ((path === '/counter' || path === '/counter/') && read) return 'allow'
    const apiMethods: Record<string, string[]> = {
      '/api/pos/session': ['GET', 'POST', 'DELETE'],
      '/api/pos/bootstrap': ['GET'], '/api/pos/receipts': ['GET'],
      '/api/pos/recovery': ['POST'], '/api/pos/devices': ['POST'], '/api/pos/sync': ['POST'], '/api/pos/commands': ['POST'],
    }
    if (apiMethods[path]?.includes(method)) return 'allow'
  }
  if (path.startsWith('/api/pos/')) return 'unavailable'
  if (!read) return 'not_found'
  if (['/', '/pos', '/pos/', '/pos.webmanifest', '/pos-sw.js', '/pos-icon.svg', '/pos-share.png', '/pos-share.svg'].includes(path)) return 'allow'
  if (path.startsWith('/_next/static/') || path.startsWith('/pos-assets/')) return 'allow'
  return 'not_found'
}
