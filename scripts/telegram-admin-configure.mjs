import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

if (existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const apiId = process.env.TELEGRAM_API_ID;
const apiHash = process.env.TELEGRAM_API_HASH;
if (!/^\d+$/.test(apiId || '') || !/^[a-f0-9]{32}$/i.test(apiHash || '')) {
  console.error(
    'Save TELEGRAM_API_ID and TELEGRAM_API_HASH from my.telegram.org/apps in ignored .dev.vars first.',
  );
  process.exit(1);
}
function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    // Do not echo CLI errors: the only output needed here is success or failure.
    child.stderr.resume();
    child.on('error', () => reject(new Error('Could not start Wrangler.')));
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `Wrangler ${args.slice(0, 2).join(' ')} failed (exit ${code}). Check your Cloudflare login.`,
            ),
          ),
    );
    child.stdin.end(input || '');
  });
}
try {
  let sessionKey = process.env.TELEGRAM_SESSION_KEY;
  if (!sessionKey) {
    const deployed = await wrangler(['secret', 'list']);
    if (/"name"\s*:\s*"TELEGRAM_SESSION_KEY"/.test(deployed))
      throw new Error(
        'A session encryption key already exists in Cloudflare. Restore your local backup; do not replace it.',
      );
    sessionKey = randomBytes(32).toString('hex');
    const previous = existsSync('.dev.vars') ? readFileSync('.dev.vars', 'utf8') : '';
    const updated = /^TELEGRAM_SESSION_KEY=/m.test(previous)
      ? previous.replace(/^TELEGRAM_SESSION_KEY=.*$/m, `TELEGRAM_SESSION_KEY=${sessionKey}`)
      : `${previous.trimEnd()}\nTELEGRAM_SESSION_KEY=${sessionKey}\n`;
    writeFileSync('.dev.vars', updated, { mode: 0o600 });
    chmodSync('.dev.vars', 0o600);
  }
  if (!/^[a-f0-9]{64}$/i.test(sessionKey))
    throw new Error('TELEGRAM_SESSION_KEY must be 32 random bytes encoded as 64 hex characters.');
  await wrangler(
    ['secret', 'bulk'],
    JSON.stringify({
      TELEGRAM_API_ID: apiId,
      TELEGRAM_API_HASH: apiHash,
      TELEGRAM_SESSION_KEY: sessionKey,
    }),
  );
  console.log(
    'Telegram admin secrets configured. The encryption key is backed up in ignored .dev.vars.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
