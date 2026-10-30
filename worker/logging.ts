import type { Database } from './database';
import type { Env } from './env';
import { errorText } from './provider-errors';

export async function writeAudit(
  db: Database,
  env: Env,
  kind: string,
  detail: string,
  userId = '',
  messageId: number | null = null,
) {
  const safe = errorText(detail, env);
  if (kind.endsWith('_error')) console.error(JSON.stringify({ event: kind, detail: safe }));
  await db.exec(
    'INSERT INTO audit (kind,user_id,message_id,detail,created_at) VALUES (?,?,?,?,?)',
    kind,
    userId,
    messageId,
    safe,
    Date.now(),
  );
}
