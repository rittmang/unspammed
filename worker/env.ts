export interface Env {
  ASSETS: { fetch(request: Request | string, init?: RequestInit): Promise<Response> };
  DEV_MODE: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_BOT_USERNAME?: string;
  DATABASE_ROOT_CHAT_ID?: string;
  WORKER_URL?: string;
  PUBLIC_URL?: string;
  BROWSER_AUTH_TOKEN?: string;
  CRON_SECRET?: string;
  DASHBOARD_URL?: string;
  OWNER_TELEGRAM_ID: string;
  ADMIN_EMAIL: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
  TELEGRAM_SESSION_KEY?: string;
  TELEGRAM_ADMIN?: DurableObjectNamespace;
  TELEGRAM_ADMIN_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  };
  POLICY_DRAFT_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  MODEL_PROVIDERS_JSON?: string;
  DATABASE_BACKEND?: 'sqlite' | 'planetscale' | 'postgres';
  DATABASE_URL?: string;
  DATABASE_ADMIN_URL?: string;
  DATABASE_SSL_MODE?: 'verify-full' | 'disable';
  DATABASE_SSL_CA?: string;
  PLANETSCALE_DATABASE_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  [key: string]: unknown;
}
