import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createAssets(directory: string) {
  const root = resolve(directory);
  return {
    async fetch(request: Request): Promise<Response> {
      if (!['GET', 'HEAD'].includes(request.method))
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
      let path: string;
      try {
        path = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response('Invalid path', { status: 400 });
      }
      if (
        path.includes('\\') ||
        path.includes('\0') ||
        path.split('/').some((p) => p.startsWith('.'))
      )
        return new Response('Not found', { status: 404 });
      if (path === '/' || !extname(path)) path = '/index.html';
      // Serve application build files only, even after owner authentication. The
      // shared router applies the narrower HTML-referenced public asset allowlist.
      if (
        !['/index.html', '/theme.js', '/favicon.svg'].includes(path) &&
        !/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path)
      )
        return new Response('Not found', { status: 404 });
      try {
        const [actualRoot, file] = await Promise.all([
          realpath(root),
          realpath(resolve(root, `.${path}`)),
        ]);
        if (!file.startsWith(actualRoot + sep)) return new Response('Not found', { status: 404 });
        const details = await stat(file);
        if (!details.isFile()) return new Response('Not found', { status: 404 });
        return new Response(request.method === 'HEAD' ? null : await readFile(file), {
          headers: {
            'Content-Type': types[extname(file)] || 'application/octet-stream',
            'Content-Length': String(details.size),
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
          return new Response('Not found', { status: 404 });
        return new Response('Static assets are unavailable', { status: 503 });
      }
    },
  };
}
