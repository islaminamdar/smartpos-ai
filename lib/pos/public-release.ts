/** The first hosted release is explicitly training-only. No legacy application,
 * server action or financial API becomes public merely by deploying its bundle. */
export function publicReleaseAccess(
  path: string,
  method: string
): 'allow' | 'not_found' | 'unavailable' {
  const read = method === 'GET' || method === 'HEAD'
  if (path === '/api/pos/health') return read ? 'allow' : 'not_found'
  if (path.startsWith('/api/pos/')) return 'unavailable'
  if (!read) return 'not_found'
  if (
    path === '/' ||
    path === '/pos' ||
    path === '/pos/' ||
    path === '/pos.webmanifest' ||
    path === '/pos-sw.js' ||
    path === '/pos-icon.svg' ||
    path === '/pos-share.png' ||
    path === '/pos-share.svg'
  )
    return 'allow'
  if (path.startsWith('/_next/static/') || path.startsWith('/pos-assets/')) return 'allow'
  return 'not_found'
}
