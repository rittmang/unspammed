import { createServer } from 'node:http';
import { loadEnvironment } from '../scripts/setup-env.mjs';
import { createNodeHandler } from './http';
import { createRuntime } from './runtime';

loadEnvironment();
const runtime = createRuntime();
const port = Number(process.env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer between 1 and 65535.');
const host = process.env.HOST || (runtime.env.DEV_MODE === 'true' ? '127.0.0.1' : '0.0.0.0');
const server = createServer(createNodeHandler(runtime));
let stopping = false;
let running: Promise<unknown> | undefined;
function tick() {
  if (stopping || running || process.env.WATCHTOWER_SCHEDULER === 'false') return;
  running = runtime
    .tick()
    .then((result) => {
      if (!result.skipped && (result.work.failed || result.cleanup?.failed || result.adminFailed))
        console.warn('Some scheduled work failed; persisted work will retry.');
      if (!result.skipped && result.work.deferred)
        console.info(
          `Scheduled ${result.work.attempted} group(s); ${result.work.deferred} deferred to later ticks.`,
        );
    })
    .catch(() =>
      console.warn('Scheduled work failed; check database and application configuration.'),
    )
    .finally(() => {
      running = undefined;
    });
}
const timer = setInterval(tick, 60_000);
timer.unref();
server.listen(port, host, () => {
  console.info(`Watchtower listening on ${host}:${port}`);
  tick();
});

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.closeIdleConnections();
  await Promise.all([new Promise<void>((resolve) => server.close(() => resolve())), running]);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
