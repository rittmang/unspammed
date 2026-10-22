import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const functionDirectory =
  process.env.UNSPAMMED_VERCEL_FUNCTION_DIR ?? process.env.WATCHTOWER_VERCEL_FUNCTION_DIR;

test('built Vercel entry boots in plain Node with protected routes and packaged dashboard assets', () => {
  if (!functionDirectory)
    assert.deepEqual(readdirSync(new URL('../.vercel-static/', import.meta.url)), ['favicon.svg']);
  const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: functionDirectory || fileURLToPath(new URL('..', import.meta.url)),
    env: {
      PUBLIC_URL: 'https://build-fixture.example',
      BROWSER_AUTH_TOKEN: 'b'.repeat(43),
      OWNER_TELEGRAM_ID: '123456789',
      TELEGRAM_BOT_TOKEN: '123456789:FAKE_BUILD_FIXTURE_NEVER_CONTACT_TELEGRAM',
      TELEGRAM_CHAT_ID: '-1001111111111',
      TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(43),
      CRON_SECRET: 'c'.repeat(43),
    },
    input: `
      import assert from 'node:assert/strict';
      import handler from './api/index.mjs';
      import {createVercelHandler} from './.vercel-runtime/handler.mjs';
      const request = (path, options) => handler.fetch(new Request('https://preview.example'+path, options));
      assert.equal((await request('/health')).status, 200);
      const shell = await request('/');
      assert.equal(shell.status, 200);
      assert.equal(shell.headers.get('X-Frame-Options'), 'DENY');
      const html = await shell.text();
      const assets = [...html.matchAll(/(?:src|href)="([^"\\s]+\\.(?:js|css))"/g)].map(match => match[1]);
      assert(assets.some(path => path.startsWith('/assets/')));
      for (const path of assets) assert.equal((await request(path)).status, 200, path);
      for (const path of ['/api/overview', '/mini/api/overview', '/api/cron'])
        assert.equal((await request(path)).status, 401, path);
      assert.equal((await request('/telegram/webhook', {method:'POST',body:'{}'})).status, 401);
      const login = await request('/api/auth/login', {
        method:'POST',
        headers:{Origin:process.env.PUBLIC_URL,'X-Unspammed-Request':'1','Content-Type':'application/json'},
        body:JSON.stringify({token:process.env.BROWSER_AUTH_TOKEN}),
      });
      assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie'), /HttpOnly/);
      const handle = createVercelHandler(() => ({
        origin:process.env.PUBLIC_URL,
        fetch:async request => Response.json({url:request.url,body:await request.text()}),
      }));
      const raw = await handle(new Request('https://preview.example/telegram/webhook?query=kept', {
        method:'POST',body:'{ "raw": "spacing matters" }',
        headers:{'Content-Type':'application/json','X-Forwarded-Host':'evil.example'},
      }));
      assert.deepEqual(await raw.json(), {
        url:process.env.PUBLIC_URL+'/telegram/webhook?query=kept',
        body:'{ "raw": "spacing matters" }',
      });
    `,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
