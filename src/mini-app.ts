import { useEffect, useRef } from 'react';

type TelegramApp = {
  initData: string;
  colorScheme: 'light' | 'dark';
  isActive?: boolean;
  ready: () => void;
  expand: () => void;
  isVersionAtLeast: (version: string) => boolean;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  setBottomBarColor: (color: string) => void;
  onEvent: (event: string, handler: () => void) => void;
  openLink: (url: string) => void;
  openTelegramLink: (url: string) => void;
  BackButton: { show: () => void; hide: () => void; onClick: (handler: () => void) => void };
};
declare global {
  interface Window {
    Telegram?: { WebApp: TelegramApp };
  }
}
export const isMiniApp =
  typeof location !== 'undefined' && /^\/mini(?:\/|$)/.test(location.pathname);
export const telegramApp =
  typeof window !== 'undefined' && isMiniApp ? window.Telegram?.WebApp : undefined;
const backHandlers = new Set<() => void>();

export function syncTelegramTheme() {
  if (!telegramApp) return;
  const root = document.documentElement;
  root.dataset.telegramTheme = telegramApp.colorScheme;
  const dark =
    root.dataset.theme === 'dark' ||
    (root.dataset.theme !== 'light' && telegramApp.colorScheme === 'dark');
  const color = dark ? '#181e18' : '#f7f8f4';
  if (telegramApp.isVersionAtLeast('6.1')) {
    telegramApp.setHeaderColor(telegramApp.isVersionAtLeast('6.9') ? color : 'bg_color');
    telegramApp.setBackgroundColor(color);
  }
  if (telegramApp.isVersionAtLeast('7.10')) telegramApp.setBottomBarColor(color);
}
export function initializeMiniApp() {
  if (!telegramApp?.initData) return;
  if (!/^#(?:overview|messages|users|lab|improvement|settings)$/.test(location.hash))
    history.replaceState(null, '', `${location.pathname}${location.search}#overview`);
  syncTelegramTheme();
  telegramApp.onEvent('themeChanged', syncTelegramTheme);
  telegramApp.BackButton.onClick(() => [...backHandlers].at(-1)?.());
  telegramApp.onEvent('activated', () => document.dispatchEvent(new Event('visibilitychange')));
  telegramApp.onEvent('deactivated', () => document.dispatchEvent(new Event('visibilitychange')));
  document.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest?.(
      'a[target="_blank"]',
    ) as HTMLAnchorElement | null;
    if (!anchor || new URL(anchor.href).protocol !== 'https:') return;
    event.preventDefault();
    if (new URL(anchor.href).hostname === 't.me') telegramApp.openTelegramLink(anchor.href);
    else telegramApp.openLink(anchor.href);
  });
  telegramApp.expand();
  telegramApp.ready();
}
export function useTelegramBack(handler: () => void, visible: boolean) {
  const current = useRef(handler);
  current.current = handler;
  useEffect(() => {
    if (!telegramApp?.initData || !visible) return;
    const back = () => current.current();
    backHandlers.add(back);
    telegramApp.BackButton.show();
    return () => {
      backHandlers.delete(back);
      if (!backHandlers.size) telegramApp.BackButton.hide();
    };
  }, [visible]);
}
export const appHidden = () => document.hidden || telegramApp?.isActive === false;
