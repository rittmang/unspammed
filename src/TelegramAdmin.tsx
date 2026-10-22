import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, Trash2, X, Search } from 'lucide-react';
import { apiForGroup } from './api';
import { Disclosure } from './Disclosure';
import { useVisiblePoll } from './poll';
import { useTelegramBack } from './mini-app';
import type { UserState } from '../shared/types';
import type { HistoryCleanup, TelegramAdminStatus } from '../shared/telegram-admin';

export function StrikeUsers({
  chatId,
  groupTitle,
  users,
  resetBusy,
  onReset,
  onComplete,
}: {
  chatId: string;
  groupTitle: string;
  users: UserState[];
  resetBusy: boolean;
  onReset: (user: UserState) => void;
  onComplete: () => Promise<void>;
}) {
  const api = useMemo(() => apiForGroup(chatId), [chatId]);
  const [status, setStatus] = useState<TelegramAdminStatus | null>(null);
  const [jobs, setJobs] = useState<HistoryCleanup[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [phone, setPhone] = useState('');
  const [value, setValue] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<UserState | null>(null);
  const [search, setSearch] = useState('');
  const visibleUsers = users.filter((user) =>
    `${user.name} ${user.user_id}`.toLowerCase().includes(search.toLowerCase()),
  );
  useTelegramBack(() => {
    if (busy) return;
    if (confirm) setConfirm(null);
    else setExpanded(false);
  }, !!confirm || expanded);
  const dialog = useRef<HTMLDivElement>(null);
  const previousJobs = useRef<HistoryCleanup[]>([]);
  useEffect(() => {
    if (!confirm) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const buttons = [
        ...(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
      ];
      const first = buttons[0],
        last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [Boolean(confirm)]);
  const load = useCallback(async () => {
    const [nextStatus, result] = await Promise.all([
      api<TelegramAdminStatus>('/telegram-admin/status'),
      api<{ jobs: HistoryCleanup[] }>(`/telegram-admin/jobs?chatId=${encodeURIComponent(chatId)}`),
    ]);
    setStatus(nextStatus);
    if (
      result.jobs.some(
        (job) =>
          job.status === 'complete' &&
          previousJobs.current.some((old) => old.id === job.id && old.status !== 'complete'),
      )
    )
      void onComplete().catch(() => {});
    previousJobs.current = result.jobs;
    setJobs(result.jobs);
  }, [api, chatId, onComplete]);
  useVisiblePoll(
    load,
    jobs.some((j) => ['queued', 'running'].includes(j.status)) ? 5000 : 60_000,
    (e) => setError(e.message),
  );
  async function action(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function login() {
    const step = status?.loginStep || 'phone';
    const entered = value;
    setValue('');
    await action('login', async () => {
      const result = await api<TelegramAdminStatus>(
        `/telegram-admin/login/${step === 'phone' ? 'start' : step}`,
        {
          method: 'POST',
          body: JSON.stringify(step === 'phone' ? { phone } : { value: entered }),
        },
      );
      setStatus(result);
      if (result.connected) {
        setExpanded(false);
        setPhone('');
        setNotice('Your Telegram admin account is connected.');
      }
    });
  }
  function userActions(user: UserState, job?: HistoryCleanup) {
    const pending = job && ['queued', 'running'].includes(job.status);
    return (
      <div className="user-actions">
        <div>
          <button
            className="text-button"
            disabled={resetBusy || !!pending}
            onClick={() => onReset(user)}
          >
            Reset{user.banned ? ' & unban' : ''}
          </button>
          <button
            className="text-button danger"
            disabled={!status?.connected || !!pending || busy === user.user_id}
            title={!status?.connected ? 'Connect your Telegram admin account first' : undefined}
            onClick={() => setConfirm(user)}
          >
            {pending ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
            {pending
              ? job.status === 'running'
                ? 'Deleting history…'
                : 'Cleanup queued'
              : job?.status === 'failed'
                ? 'Retry cleanup'
                : 'Delete all messages'}
          </button>
        </div>
        {job && (
          <small role="status" className={job.status === 'failed' ? 'history-error' : 'subtle'}>
            {job.status === 'complete'
              ? `History deleted · ${new Date(job.updatedAt).toLocaleString()}`
              : job.error || (pending ? 'Full history, including older messages' : '')}
          </small>
        )}
      </div>
    );
  }
  const active = jobs.filter((j) => ['queued', 'running'].includes(j.status));
  return (
    <>
      <section className="panel strikes-panel">
        <div className="panel-heading">
          <h2>
            {users.length} {users.length === 1 ? 'person' : 'people'} with strikes
          </h2>
        </div>
        <label className="search-field strike-search">
          <Search size={16} />
          <input
            aria-label="Search strike history"
            type="search"
            placeholder="Find a person…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {visibleUsers.length ? (
          <>
            <div className="phone-only compact-list strike-list">
              {visibleUsers.map((user) => {
                const job = jobs.find((item) => item.userId === user.user_id);
                const state = user.banned ? 'Banned' : user.strikes >= 3 ? 'Ban queued' : 'Active';
                return (
                  <Disclosure
                    key={user.user_id}
                    className="compact-record"
                    label={`Strike details for ${user.name}`}
                    title={
                      <span className="record-title">
                        <span>{user.name}</span>
                        <span className={`record-count ${user.strikes >= 2 ? 'red' : ''}`}>
                          {user.strikes} / 3
                        </span>
                      </span>
                    }
                    hint={
                      <>
                        <span>
                          {state} · Seen{' '}
                          {new Date(user.last_seen).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        {job && ['queued', 'running', 'failed'].includes(job.status) && (
                          <span className={job.status === 'failed' ? 'red' : ''}>
                            {' '}
                            · {job.status === 'failed' ? 'Cleanup failed' : 'Cleanup in progress'}
                          </span>
                        )}
                      </>
                    }
                  >
                    <div className="record-detail">
                      <dl className="fact-grid">
                        <div>
                          <dt>Telegram user ID</dt>
                          <dd>{user.user_id}</dd>
                        </div>
                        <div>
                          <dt>Last seen</dt>
                          <dd>{new Date(user.last_seen).toLocaleString()}</dd>
                        </div>
                      </dl>
                      {userActions(user, job)}
                      {!status?.connected && (
                        <p className="field-help">
                          <a
                            href="#telegram-admin-account"
                            onClick={(event) => {
                              event.preventDefault();
                              const account = document.getElementById(
                                'telegram-admin-account',
                              ) as HTMLDetailsElement;
                              if (!account.open) account.querySelector('summary')?.click();
                              document
                                .getElementById('telegram-admin-account')
                                ?.scrollIntoView({ block: 'start' });
                            }}
                          >
                            Connect your Telegram account
                          </a>{' '}
                          to delete full history.
                        </p>
                      )}
                    </div>
                  </Disclosure>
                );
              })}
            </div>
            <div
              className="table-scroll desktop-only"
              role="region"
              aria-label="Strike history"
              tabIndex={0}
            >
              <table className="strike-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Strikes</th>
                    <th>Status</th>
                    <th>Last seen</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => {
                    const job = jobs.find((j) => j.userId === user.user_id);
                    return (
                      <tr key={user.user_id}>
                        <td>
                          <div className="user-cell">
                            <div>
                              <strong>{user.name}</strong>
                              <small>{user.user_id}</small>
                            </div>
                          </div>
                        </td>
                        <td data-label="Strikes">
                          <span className="strike-count">{user.strikes} / 3</span>
                        </td>
                        <td data-label="Status">
                          <span
                            className={`badge ${user.banned ? 'banned' : user.strikes >= 3 ? 'pending' : 'active'}`}
                          >
                            {user.banned ? 'banned' : user.strikes >= 3 ? 'ban queued' : 'active'}
                          </span>
                        </td>
                        <td className="muted" data-label="Last seen">
                          {new Date(user.last_seen).toLocaleDateString()}
                        </td>
                        <td className="history-actions">{userActions(user, job)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <h3>{search ? 'No matching people' : 'A clean slate'}</h3>
            <p>
              {search
                ? 'Try a different name or Telegram ID.'
                : 'No strikes have been recorded. Observation mode never awards strikes.'}
            </p>
          </div>
        )}
      </section>
      <Disclosure
        id="telegram-admin-account"
        className="panel telegram-admin-panel"
        title="Telegram admin account"
        hint={
          status?.connected
            ? `Connected as ${status.account?.name}`
            : 'Connect for full-history cleanup'
        }
      >
        <div className="account-settings">
          <p className="field-help">
            Delete a user's full message history, including older messages.
          </p>
          {!status?.connected && (
            <button
              className="button secondary"
              disabled={!status?.configured || !!busy}
              onClick={() => setExpanded(!expanded)}
            >
              Connect account
            </button>
          )}
          {status && !status.configured && (
            <p className="field-help">
              The admin connection needs its one-time Telegram application setup. Get your API ID
              and hash from{' '}
              <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
                my.telegram.org
              </a>{' '}
              and configure them on the server.
            </p>
          )}
          {status?.connected && (
            <div className="admin-account-detail">
              <p className="field-help">
                Connected to your owner account. History cleanup runs only when you confirm it for a
                selected user.
              </p>
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() =>
                  void action('disconnect', async () => {
                    setStatus(
                      await api<TelegramAdminStatus>('/telegram-admin/disconnect', {
                        method: 'POST',
                        body: '{}',
                      }),
                    );
                    await load();
                  })
                }
              >
                Disconnect account
              </button>
            </div>
          )}
          {expanded && status && !status.connected && (
            <form
              className="admin-login"
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <label className="field">
                <span>
                  {status.loginStep === 'phone'
                    ? 'Your Telegram phone number'
                    : status.loginStep === 'code'
                      ? 'Telegram login code'
                      : 'Two-step verification password'}
                </span>
                {status.loginStep === 'phone' ? (
                  <input
                    autoFocus
                    type="tel"
                    autoComplete="tel"
                    placeholder="+1 555 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[\s()-]/g, ''))}
                    required
                  />
                ) : (
                  <input
                    autoFocus
                    key={status.loginStep}
                    type={status.loginStep === 'password' ? 'password' : 'text'}
                    inputMode={status.loginStep === 'code' ? 'numeric' : undefined}
                    autoComplete={status.loginStep === 'code' ? 'one-time-code' : 'off'}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    required
                  />
                )}
              </label>
              <p className="field-help">
                {status.loginStep === 'phone'
                  ? 'Use the account configured as Unspammed’s owner. Telegram sends the code to your Telegram app or phone.'
                  : status.loginStep === 'code'
                    ? 'Enter the code Telegram sent you. Keep this page open while connecting.'
                    : 'Your password is used once to sign in and is never saved.'}
              </p>
              <div className="admin-login-actions">
                <button className="button primary" disabled={!!busy} type="submit">
                  {busy === 'login' && <LoaderCircle size={14} className="spin" />}
                  {status.loginStep === 'phone' ? 'Send login code' : 'Continue'}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={!!busy}
                  onClick={() =>
                    void action('cancel', async () => {
                      setStatus(
                        await api<TelegramAdminStatus>('/telegram-admin/login/cancel', {
                          method: 'POST',
                          body: '{}',
                        }),
                      );
                      setExpanded(false);
                      setPhone('');
                      setValue('');
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {!!active.length && (
            <p className="field-help" role="status">
              {active.length} history {active.length === 1 ? 'cleanup is' : 'cleanups are'} queued
              or running. You can leave this page; progress is saved.
            </p>
          )}
        </div>
      </Disclosure>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="field-help">
          {notice}
        </p>
      )}
      {confirm && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setConfirm(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !busy) setConfirm(null);
          }}
        >
          <div
            ref={dialog}
            className="modal history-confirm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="history-confirm-title">Delete all messages from {confirm.name}?</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="Cancel history deletion"
                disabled={!!busy}
                onClick={() => setConfirm(null)}
              >
                <X size={18} />
              </button>
            </div>
            <p>
              This permanently deletes this user’s entire message history in{' '}
              <strong>{groupTitle}</strong>, including messages older than 48 hours. It uses your
              connected Telegram admin account.
            </p>
            <p>Their strikes and ban stay as they are. This cannot be undone.</p>
            <div className="modal-actions">
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() => {
                  const user = confirm;
                  void action(user.user_id, async () => {
                    const job = await api<HistoryCleanup>(`/users/${user.user_id}/delete-history`, {
                      method: 'POST',
                      body: JSON.stringify({ confirmUserId: user.user_id }),
                    });
                    setJobs((old) => [job, ...old.filter((j) => j.id !== job.id)]);
                    setConfirm(null);
                    setNotice(`Full-history cleanup queued for ${user.name}.`);
                  });
                }}
              >
                {busy === confirm.user_id && <LoaderCircle size={14} className="spin" />}Delete all
                messages
              </button>
            </div>
            {error && (
              <p className="alert" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
