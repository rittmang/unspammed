export interface Env {
  ASSETS: Fetcher;
  DEV_MODE: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_BOT_USERNAME?: string;
  DATABASE_ROOT_CHAT_ID?: string;
  WORKER_URL?: string;
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
  POLICY_DRAFT_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  MODEL_PROVIDERS_JSON?: string;
  DATABASE_BACKEND?: 'sqlite' | 'planetscale';
  PLANETSCALE_DATABASE_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  [key: string]: unknown;
}
