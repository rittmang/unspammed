import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function client() {
  vi.resetModules();
  vi.stubGlobal('location', { pathname: '/mini/', search: '', hash: '#tgWebAppData=launch-data' });
  const events = new Map<string, () => void>();
  const sdk = {
    initData: 'signed-launch-data',
    colorScheme: 'dark',
    isActive: true,
    isVersionAtLeast: vi.fn(() => true),
    ready: vi.fn(),
    expand: vi.fn(),
    setHeaderColor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setBottomBarColor: vi.fn(),
    onEvent: vi.fn((name, handler) => events.set(name, handler)),
    BackButton: { onClick: vi.fn(), show: vi.fn(), hide: vi.fn() },
  };
  vi.stubGlobal('window', { Telegram: { WebApp: sdk } });
  const root = { dataset: { theme: 'system' } as Record<string, string> };
  const dispatch = vi.fn();
  vi.stubGlobal('document', {
    documentElement: root,
    hidden: false,
    addEventListener: vi.fn(),
    dispatchEvent: dispatch,
  });
  const history = { replaceState: vi.fn() };
  vi.stubGlobal('history', history);
  return {
    sdk,
    events,
    root,
    dispatch,
    history,
    api: await import('../src/api'),
    mini: await import('../src/mini-app'),
  };
}
it('sends launch authentication only to the Mini App API and preserves selected group headers', async () => {
  const { api } = await client();
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetch);
  await api.apiForGroup('-100111')('/messages');
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/mini/api/messages');
  expect(init.credentials).toBe('omit');
  expect(init.redirect).toBe('error');
  expect(new Headers(init.headers).get('X-Telegram-Init-Data')).toBe('signed-launch-data');
  expect(new Headers(init.headers).get('X-Watchtower-Group')).toBe('-100111');
  await api.fetchApi('/messages/1/image?group=-100111');
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/mini/api/messages/1/image?group=-100111');
  for (const path of ['/../../api/auth/login', '/../outside', '/%2e%2e/outside', 'groups'])
    expect(() => api.fetchApi(path)).toThrow('Invalid dashboard API path.');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('uploads exports once and reports expired launch authentication without retrying it', async () => {
  const { api } = await client();
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetch);
  const file = new Blob(['{"examples":[]}']);
  await api.downloadBlob('watchtower-dataset.json', file);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/mini/api/telegram-export');
  expect(init.body).toBe(file);
  expect(new Headers(init.headers).get('X-Watchtower-File-Name')).toBe('watchtower-dataset.json');
  fetch.mockResolvedValueOnce(Response.json({ error: 'Expired' }, { status: 401 }));
  await expect(api.api('/groups')).rejects.toMatchObject({
    status: 401,
    message: expect.stringContaining('reopen'),
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps the normal browser API independent of Telegram identity', async () => {
  await client();
  vi.resetModules();
  vi.stubGlobal('location', { pathname: '/' });
  const api = await import('../src/api');
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ ok: true }),
  );
  vi.stubGlobal('fetch', fetch);
  await api.api('/groups');
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/groups');
  expect(new Headers(init.headers).has('X-Telegram-Init-Data')).toBe(false);
  expect(init.credentials).toBeUndefined();
});
it('initializes native navigation, clears the launch fragment, follows Telegram theme and activation events', async () => {
  const { mini, sdk, events, root, history, dispatch } = await client();
  mini.initializeMiniApp();
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/mini/#overview');
  expect(sdk.ready).toHaveBeenCalledOnce();
  expect(sdk.expand).toHaveBeenCalledOnce();
  expect(root.dataset.telegramTheme).toBe('dark');
  expect(sdk.setHeaderColor).toHaveBeenLastCalledWith('#181e18');
  sdk.colorScheme = 'light';
  events.get('themeChanged')!();
  expect(root.dataset.telegramTheme).toBe('light');
  expect(sdk.setBottomBarColor).toHaveBeenLastCalledWith('#f7f8f4');
  root.dataset.theme = 'dark';
  mini.syncTelegramTheme();
  expect(sdk.setHeaderColor).toHaveBeenLastCalledWith('#181e18');
  sdk.isActive = false;
  events.get('deactivated')!();
  expect(mini.appHidden()).toBe(true);
  sdk.isActive = true;
  events.get('activated')!();
  expect(mini.appHidden()).toBe(false);
  expect(dispatch).toHaveBeenCalledTimes(2);
});
it('uses supported header colors and avoids newer native calls on older Telegram clients', async () => {
  const { mini, sdk } = await client();
  sdk.isVersionAtLeast.mockImplementation((version?: string) => version === '6.1');
  mini.syncTelegramTheme();
  expect(sdk.setHeaderColor).toHaveBeenCalledWith('bg_color');
  expect(sdk.setBottomBarColor).not.toHaveBeenCalled();
});
