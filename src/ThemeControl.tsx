import { useState } from 'react';
import { syncTelegramTheme } from './mini-app';

export function ThemeControl() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'system');
  return (
    <label className="theme-control">
      <span className="sr-only">Color theme</span>
      <select
        aria-label="Color theme"
        value={theme}
        onChange={(event) => {
          const value = event.target.value;
          setTheme(value);
          document.documentElement.dataset.theme = value;
          syncTelegramTheme();
          try {
            localStorage.setItem('watchtower:theme', value);
          } catch {
            // The selection still works when browser storage is unavailable.
          }
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
