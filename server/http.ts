import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../worker/http';
import type { Runtime } from './runtime';

export function requestUrl(target: string | undefined, origin: string) {
  if (!target?.startsWith('/') || target.startsWith('//') || target.includes('\\'))
    throw new HttpError(400, 'Invalid request target.');
  const url = new URL(target, origin);
  if (url.origin !== origin) throw new HttpError(400, 'Invalid request target.');
  return url;
}

export function createNodeHandler(
  runtime: Pick<Runtime, 'origin' | 'fetch' | 'env'> & Partial<Pick<Runtime, 'requestOrigin'>>,
) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    incoming.once('aborted', abort);
    outgoing.once('close', () => {
      if (!outgoing.writableEnded) abort();
    });
    try {
      if (
        runtime.env.DEV_MODE === 'true' &&
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(incoming.socket.remoteAddress || '')
      )
        throw new HttpError(403, 'Development access is restricted to loopback.');
      const url = requestUrl(
        incoming.url,
        runtime.requestOrigin?.(incoming.headers.host) || runtime.origin,
      );
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
        else if (value !== undefined) headers.set(key, value);
      }
      // URL, origin validation, cookies, and redirects all use the configured public
      // origin. Untrusted forwarded host/protocol headers never choose an origin.
      headers.set('Host', url.host);
      const method = incoming.method || 'GET';
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        signal: controller.signal,
      };
      if (!['GET', 'HEAD'].includes(method)) {
        // Cancelling an oversized/invalid body must still allow its error response
        // to flush. Readable.toWeb() cancellation destroys the shared HTTP socket.
        const iterator = incoming.iterator({ destroyOnReturn: false });
        init.body = new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const next = await iterator.next();
              if (next.done) stream.close();
              else stream.enqueue(next.value);
            } catch (error) {
              stream.error(error);
            }
          },
          async cancel() {
            await iterator.return?.();
          },
        });
        init.duplex = 'half';
      }
      const response = await runtime.fetch(new Request(url, init));
      if (!incoming.complete) {
        outgoing.shouldKeepAlive = false;
        outgoing.once('finish', () => incoming.destroy());
      }
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers)
        if (name.toLowerCase() !== 'set-cookie') outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
      if (method === 'HEAD' || !response.body) {
        await response.body?.cancel();
        outgoing.end();
      } else await pipeline(Readable.fromWeb(response.body as any), outgoing);
    } catch (error) {
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      outgoing.statusCode = error instanceof HttpError ? error.status : 500;
      outgoing.setHeader('Content-Type', 'application/json; charset=utf-8');
      outgoing.setHeader('Cache-Control', 'no-store');
      outgoing.end(
        JSON.stringify({ error: error instanceof HttpError ? error.message : 'Request failed.' }),
      );
    } finally {
      incoming.off('aborted', abort);
    }
  };
}
