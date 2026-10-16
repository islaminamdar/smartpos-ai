// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function workerHarness(failPath?: string) {
  const handlers = new Map<string, (event: any) => void>();
  const namespaces = new Map<string, Map<string, Response>>();
  const old = new Map<string, Response>([['/pos', new Response('old working shell')], ['/pos-offline-complete', new Response('ready')]]);
  namespaces.set('internext-pos-shell-old', old);
  const notifications: any[] = [];
  const fetches: string[] = [];
  const resources: Record<string, [string, string]> = {
    '/pos': ['<html><link href="/_next/static/app.css" rel="stylesheet"><script src="/_next/static/app.js"></script></html>', 'text/html'],
    '/_next/static/app.css': ['@import "./more.css"; @font-face { src: url("./font.woff2") }', 'text/css'],
    '/_next/static/more.css': ['body { background: url("/pos-assets/background.webp") }', 'text/css'],
    '/pos-assets/offline-assets.json': [JSON.stringify(['/pos-assets/menu.webp']), 'application/json'],
  };
  let claimed = false;
  const caches = {
    async open(name: string) {
      if (!namespaces.has(name)) namespaces.set(name, new Map());
      const entries = namespaces.get(name)!;
      const key = (path: string | Request) => typeof path === 'string' ? path : new URL(path.url).pathname;
      return { async put(path: string | Request, response: Response) { entries.set(key(path), response.clone()); }, async match(path: string | Request) { return entries.get(key(path))?.clone(); } };
    },
    async keys() { return [...namespaces.keys()]; },
    async delete(name: string) { return namespaces.delete(name); },
  };
  runInNewContext(readFileSync('scripts/pos-sw.template.js', 'utf8').replaceAll('__POS_BUILD_VERSION__', 'test-release'), {
    self: { location: { origin: 'http://localhost' }, addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler); }, clients: { async claim() { claimed = true; }, async matchAll() { return [{ url: 'http://localhost/pos', postMessage(message: any) { notifications.push(message); } }]; } } },
    caches, URL, Response,
    async fetch(path: string) { fetches.push(path); if (path === failPath) return new Response('download failure', { status: 503 }); const [body, type] = resources[path] ?? ['asset bytes', 'application/octet-stream']; return new Response(body, { headers: { 'Content-Type': type } }); },
  });
  return {
    namespaces, notifications, fetches, get claimed() { return claimed; },
    async event(name: string, fields: Record<string, unknown> = {}) { let task: Promise<unknown> | undefined; handlers.get(name)!({ ...fields, waitUntil(promise: Promise<unknown>) { task = promise; } }); await task; },
    fetchEvent(url: string, mode = 'navigate') { let response: Promise<Response> | undefined; handlers.get('fetch')!({ request: { method: 'GET', url, mode }, respondWith(promise: Promise<Response>) { response = promise; } }); return response; },
  };
}

describe('versioned offline worker', () => {
  it('does not put manager uploads into the unbounded training-shell runtime cache', async () => {
    const worker = workerHarness(); await worker.event('install');
    const before = [...worker.namespaces.get('internext-pos-shell-test-release')!.keys()];
    expect(worker.fetchEvent('http://localhost/pos-assets/menu/upload_123456781234123412341234567890ab.webp', 'cors')).toBeUndefined();
    expect([...worker.namespaces.get('internext-pos-shell-test-release')!.keys()]).toEqual(before);
  });
  it('caches shell, HTML scripts/styles, nested CSS dependencies and all menu assets before readiness', async () => {
    const worker = workerHarness(); await worker.event('install');
    const cache = worker.namespaces.get('internext-pos-shell-test-release')!;
    expect([...cache.keys()]).toEqual(expect.arrayContaining(['/pos', '/_next/static/app.js', '/_next/static/app.css', '/_next/static/more.css', '/_next/static/font.woff2', '/pos-assets/background.webp', '/pos-assets/menu.webp', '/pos-assets/offline-assets.json', '/pos.webmanifest', '/pos-icon.svg', '/pos-offline-complete']));
    expect(worker.namespaces.has('internext-pos-shell-old')).toBe(true);
    expect(worker.notifications.some(message => message.type === 'POS_OFFLINE_READY')).toBe(false);
    await worker.event('activate');
    expect(worker.namespaces.has('internext-pos-shell-old')).toBe(false);
    expect(worker.claimed).toBe(true);
    expect(worker.notifications.some(message => message.type === 'POS_OFFLINE_READY')).toBe(true);
    const cached = await worker.fetchEvent('http://localhost/pos');
    expect(await cached?.text()).toContain('/_next/static/app.js');
    expect(worker.fetchEvent('http://localhost/api/pos/bootstrap', 'cors')).toBeUndefined();
  });
  it('failed new installation preserves the active shell and removes only its own incomplete cache', async () => {
    const worker = workerHarness('/pos-assets/menu.webp');
    await expect(worker.event('install')).rejects.toThrow('Offline download failed');
    expect(await worker.namespaces.get('internext-pos-shell-old')?.get('/pos')?.clone().text()).toBe('old working shell');
    expect(worker.namespaces.has('internext-pos-shell-test-release')).toBe(false);
    expect(worker.notifications.some(message => message.type === 'POS_OFFLINE_FAILED')).toBe(true);
    expect(worker.notifications.some(message => message.type === 'POS_OFFLINE_READY')).toBe(false);
  });
});
