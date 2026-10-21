try {
  const theme = localStorage.getItem('watchtower:theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
if (document.documentElement.dataset.miniApp && window.Telegram?.WebApp)
  document.documentElement.dataset.telegramTheme = window.Telegram.WebApp.colorScheme;
