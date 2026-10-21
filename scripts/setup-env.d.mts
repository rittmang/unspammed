export function loadEnvironment(options?: { cwd?: string; env?: NodeJS.ProcessEnv }): {
  path: string | undefined;
  env: NodeJS.ProcessEnv;
};
export function canonicalEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv & {
  PUBLIC_URL: string;
  DATABASE_URL: string;
  DATABASE_ADMIN_URL: string;
  DATABASE_SSL_MODE: string;
};
