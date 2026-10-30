// Disposable hosted smoke fixture. Never use installation credentials or production data.
import { GroupModerator } from '../../worker/local-group';
import { SqliteDatabase } from '../../worker/database';
import { json } from '../../worker/http';
import type { Env } from '../../worker/env';

type ProbeEnv = Env & {
  RETRY_PROBE_SECRET: string;
  UNSPAMMED_TEST_FIXTURE: string;
  PROBE: DurableObjectNamespace;
};

export class RetryProbe extends GroupModerator {
  constructor(
    private state: DurableObjectState,
    env: ProbeEnv,
  ) {
    super(state, env);
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/provider/chat/completions') {
      const body = (await request.json()) as any;
      const drafting = body.messages[0].content.startsWith('Draft a complete replacement');
      const kind = drafting ? 'draft' : 'evaluation';
      const attempts = ((await this.state.storage.get<number>(kind)) || 0) + 1;
      await this.state.storage.put(kind, attempts);
      if (attempts === 1)
        return Response.json(
          {
            error: {
              code: 429,
              message: `Synthetic ${kind} rate limit`,
              metadata: {
                raw: 'The upstream quota is temporarily exhausted. Hosted retry end marker.',
                provider_name: 'Isolated test provider',
              },
            },
          },
          { status: 429, headers: { 'Retry-After': '120', 'X-Request-ID': `probe-${kind}` } },
        );
      const content = drafting
        ? {
            diagnosis: 'A synthetic rule clarification.',
            edits: [
              {
                before: JSON.parse(body.messages[1].content).existingPolicy,
                after:
                  'Flag deceptive unsolicited promotion. Allow ordinary questions and useful community conversation.',
              },
            ],
          }
        : {
            results: JSON.parse(body.messages[1].content).messages.map((m: { id: string }) => ({
              id: m.id,
              score: 0.05,
              category: 'ordinary',
              reason: 'Synthetic harmless question',
              needs_review: false,
            })),
          };
      return Response.json({
        model: body.model,
        provider: 'Isolated test provider',
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.00001 },
      });
    }
    if (path === '/probe/tick') {
      await this.processBatch();
      return json({ ok: true });
    }
    if (path === '/probe/state') {
      const db = new SqliteDatabase(this.state);
      return json({
        attempts: {
          draft: (await this.state.storage.get('draft')) || 0,
          evaluation: (await this.state.storage.get('evaluation')) || 0,
        },
        evaluations: await db.exec(
          'SELECT id,status,cursor,total,input_tokens,output_tokens,usage_estimated,cost,cost_complete,model_meta,next_at,retry_attempts,error FROM evaluations',
        ),
        drafts: (await db.exec<{ payload: string }>('SELECT payload FROM policy_drafts')).map((r) =>
          JSON.parse(r.payload),
        ),
        usage: await db.exec('SELECT * FROM usage'),
        audit: await db.exec('SELECT kind,detail FROM audit'),
      });
    }
    return super.fetch(request);
  }
}

export default {
  async fetch(request: Request, env: ProbeEnv) {
    if (env.UNSPAMMED_TEST_FIXTURE !== 'true') return json({ error: 'Test fixture disabled' }, 503);
    const provider = new URL(request.url).pathname.startsWith('/provider/');
    const expected = provider ? env.OPENROUTER_API_KEY : env.RETRY_PROBE_SECRET;
    if (!expected || request.headers.get('Authorization') !== `Bearer ${expected}`)
      return json({ error: 'Unauthorized' }, 401);
    return env.PROBE.get(env.PROBE.idFromName('isolated-retry-probe')).fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: ProbeEnv) {
    if (env.UNSPAMMED_TEST_FIXTURE !== 'true') return;
    await env.PROBE.get(env.PROBE.idFromName('isolated-retry-probe')).fetch(
      new Request('https://probe.internal/probe/tick', { method: 'POST' }),
    );
  },
};
