import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { isMiniApp, telegramApp } from './mini-app';

type AuthStatus = {
  authenticated: boolean;
  telegram: boolean;
  botUsername: string;
  browserToken: boolean;
  cloudflareAccess: boolean;
  dashboardUrl: string;
};
function shellStatus(): AuthStatus {
  const data = document.documentElement.dataset;
  return {
    authenticated: false,
    telegram: data.telegramAuth === 'true',
    botUsername: data.botUsername || '',
    browserToken: data.browserAuth === 'true',
    cloudflareAccess: data.accessAuth === 'true',
    dashboardUrl: data.dashboardUrl || '',
  };
}
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(isMiniApp ? shellStatus() : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const miniAuthenticated = isMiniApp && !!telegramApp?.initData;
  async function refresh() {
    try {
      const response = await fetch('/api/auth/status', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error('The sign-in options could not load. Reload to retry.');
      setStatus(await response.json());
    } catch {
      setError('The sign-in options could not load. Reload to retry.');
    }
  }
  useEffect(() => {
    if (isMiniApp) return;
    void refresh();
    const expired = () => {
      setStatus((current) => current && { ...current, authenticated: false });
      setError('Your session has expired. Sign in again.');
    };
    window.addEventListener('watchtower:unauthorized', expired);
    return () => window.removeEventListener('watchtower:unauthorized', expired);
  }, []);
  async function signIn(event: FormEvent) {
    event.preventDefault();
    const token = input.current?.value || '';
    if (input.current) input.current.value = '';
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Unspammed-Request': '1',
          'X-Watchtower-Request': '1',
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'The sign-in token is incorrect.'
            : 'Sign-in failed. Check the host configuration and try again.',
        );
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Sign-in failed. Try again.');
    } finally {
      setBusy(false);
    }
  }
  if (miniAuthenticated || status?.authenticated) return children;
  return (
    <main className="group-bootstrap sign-in">
      <h1>Sign in to Unspammed</h1>
      <p>
        {status
          ? 'Choose an owner sign-in method configured for this installation.'
          : 'Loading sign-in options…'}
      </p>
      <div className="sign-in-actions">
        {status?.telegram && status.botUsername && (
          <a
            className="button primary"
            href={`https://t.me/${encodeURIComponent(status.botUsername)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Telegram
          </a>
        )}
        {status?.cloudflareAccess && status.dashboardUrl && (
          <a
            className="button secondary"
            href={status.dashboardUrl}
            target={isMiniApp ? '_blank' : undefined}
            rel="noopener noreferrer"
          >
            Sign in with Cloudflare
          </a>
        )}
        {isMiniApp && status?.browserToken && status.dashboardUrl && (
          <a
            className="button secondary"
            href={new URL('/login', status.dashboardUrl).href}
            target="_blank"
            rel="noopener noreferrer"
          >
            Sign in in your browser
          </a>
        )}
        {!isMiniApp && status?.browserToken && (
          <form onSubmit={signIn} className="sign-in-actions">
            <label htmlFor="owner-token">Owner sign-in token</label>
            <input
              ref={input}
              id="owner-token"
              type="password"
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="token-help"
            />
            <small id="token-help">Use the private token generated during setup.</small>
            <button className="button primary" disabled={busy} type="submit">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
      {status?.telegram && <p>In your private chat with the bot, choose Open dashboard.</p>}
      {status &&
        !status.browserToken &&
        !status.cloudflareAccess &&
        (!status.telegram || !status.botUsername) && (
          <p>The host owner needs to finish configuring a sign-in method.</p>
        )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export async function signOutBrowser() {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'X-Unspammed-Request': '1', 'X-Watchtower-Request': '1' },
  });
  if (!response.ok) throw new Error('Could not sign out. Try again.');
  window.dispatchEvent(new Event('watchtower:unauthorized'));
}
