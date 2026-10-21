import { requestUrl } from '../server/http';
import { createRuntime, type Runtime } from '../server/runtime';

// Native Web handlers run on Vercel's Node runtime and preserve the request body
// without legacy IncomingMessage helpers parsing and reconstructing its stream.
// The plan must support a 300-second invocation and a per-minute cron schedule.
export const maxDuration = 300;

export function createVercelHandler(
  resolveRuntime: () => Runtime = () =>
    createRuntime(process.env, { allowDevelopment: false, schedulerGroups: 1 }),
) {
  let runtime: Runtime | undefined;
  return async function fetch(request: Request): Promise<Response> {
    try {
      runtime ||= resolveRuntime();
      const incoming = new URL(request.url);
      const canonical = requestUrl(
        incoming.pathname + incoming.search,
        runtime.requestOrigin?.(incoming.host) || runtime.origin,
      );
      // Canonical origin comes only from PUBLIC_URL; forwarded host/protocol cannot
      // change CSRF or cookie scope. Vercel rewrites retain the original path/query.
      return await runtime.fetch(new Request(canonical, request));
    } catch {
      return Response.json(
        { error: 'Configure the application public URL and runtime environment.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
}

export default { fetch: createVercelHandler() };
