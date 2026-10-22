import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { prepareDevEnvironment } from './dev-env.mjs';

const { path: envPath, childEnv, explicit } = prepareDevEnvironment();
const args = [
  'exec',
  '--',
  'wrangler',
  'dev',
  '--config',
  'wrangler.local.jsonc',
  '--env-file',
  envPath,
  '--persist-to',
  '.tmp/dev/state',
  '--ip',
  '127.0.0.1',
  '--port',
  '8787',
  '--local-upstream',
  '127.0.0.1:8787',
  '--upstream-protocol',
  'http',
  '--var',
  'DEV_MODE:true',
  '--var',
  'DATABASE_BACKEND:sqlite',
];
console.log(
  `Unspammed: http://127.0.0.1:5173 (local owner access). ${explicit ? 'Explicit test credentials copied into isolated local configuration.' : 'Demo data only; existing .env and .dev.vars are untouched.'}`,
);
// Assets must exist for Wrangler, even though Vite serves the UI in development.
if (!existsSync('dist/index.html')) {
  const build = spawn('npm', ['run', 'build'], { stdio: 'inherit', env: childEnv });
  await new Promise((resolve) =>
    build.on('exit', (code) => (code ? process.exit(code) : resolve())),
  );
}
const worker = spawn('npm', args, { stdio: 'inherit', env: childEnv });
const ui = spawn('npm', ['run', 'dev:ui'], { stdio: 'inherit', env: childEnv });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  worker.kill('SIGTERM');
  ui.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
worker.on('exit', stop);
ui.on('exit', stop);
