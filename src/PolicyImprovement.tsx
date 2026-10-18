import { useCallback, useMemo, useState } from 'react';
import { Check, LoaderCircle, RotateCcw } from 'lucide-react';
import { apiForGroup } from './api';
import { useVisiblePoll } from './poll';
import {
  digest,
  policyProgress,
  type ImprovementOverview,
  type PolicyDraft,
} from '../shared/improvement';

const working = ['queued', 'drafting', 'preparing', 'development', 'validation', 'test'];
const stages = [
  { id: 'drafting', label: 'Draft update' },
  { id: 'development', label: 'Test feedback' },
  { id: 'validation', label: 'Check fresh messages' },
  { id: 'test', label: 'Final check' },
  { id: 'approval', label: 'Your approval' },
] as const;

function ImprovementProgress({ draft }: { draft: PolicyDraft }) {
  const progress = draft.progress || policyProgress(draft);
  const stage = stages.findIndex((s) => s.id === progress.stage);
  const running = working.includes(draft.status);
  const published = draft.status === 'published';
  const awaitingApproval = draft.status === 'ready';
  // A completed replay still needs its quality gate before this stage is done.
  const fraction = progress.totalChecks
    ? Math.min(0.9, progress.completedChecks / progress.totalChecks)
    : 0;
  const value = published ? stages.length : stage + fraction;
  const state = published ? 'Complete' : running || awaitingApproval ? 'Step' : 'Stopped at step';
  return (
    <div className="policy-progress">
      <div className="policy-progress-meta">
        <p className="policy-progress-current">
          {published ? 'All steps complete' : `${state} ${stage + 1} of ${stages.length}`}
        </p>
        {draft.optimization && (
          <span className="policy-progress-revision">
            Revision {draft.optimization.attempt} of {draft.optimization.maxAttempts}
          </span>
        )}
      </div>
      <div
        className={`policy-progress-track${running ? ' is-running' : ''}`}
        role="progressbar"
        aria-label="Policy improvement"
        aria-valuemin={0}
        aria-valuemax={stages.length}
        aria-valuenow={value}
        aria-valuetext={
          published
            ? 'All steps complete. Policy approved.'
            : `${state} ${stage + 1} of ${stages.length}: ${stages[stage].label}${
                progress.totalChecks
                  ? `. ${progress.completedChecks} of ${progress.totalChecks} checks complete`
                  : ''
              }`
        }
      >
        <span
          className="policy-progress-fill"
          style={{ width: `${(value / stages.length) * 100}%` }}
        />
      </div>
      <ol className="policy-progress-stages" aria-label="Improvement stages">
        {stages.map((s, i) => {
          const done = published || i < stage;
          const current = !published && i === stage;
          return (
            <li
              key={s.id}
              className={done ? 'is-complete' : current ? 'is-current' : ''}
              aria-current={current ? 'step' : undefined}
            >
              <span className="policy-progress-marker" aria-hidden="true">
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span>{s.label}</span>
              <span className="sr-only">
                {done ? ' complete' : current ? ' current step' : ' upcoming'}
              </span>
            </li>
          );
        })}
      </ol>
      {progress.totalChecks > 0 && (
        <p className="policy-progress-detail">
          {progress.completedChecks} of {progress.totalChecks} checks complete
          <span>Comparing your current policy with this revision</span>
        </p>
      )}
      {running && draft.optimization && draft.optimization.attempt > 1 && (
        <p className="policy-progress-detail">
          Learning from the previous results. Each revision goes through these checks again.
        </p>
      )}
    </div>
  );
}

function ActionError({ message, dismiss }: { message?: string; dismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="alert policy-action-error" role="alert">
      <span>{message}</span>
      <button className="text-button" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

function updateTitle(d: PolicyDraft) {
  if (working.includes(d.status)) return 'Improving your policy';
  if (d.status === 'ready') return 'Improved policy ready';
  if (d.status === 'published') return 'Your policy has been updated';
  if (d.status === 'needs_examples') return 'More feedback will help';
  if (d.status === 'failed') return 'This update is paused';
  if (d.status === 'stale') return 'Your settings have changed';
  if (['draft', 'validated'].includes(d.status)) return 'Continue improving your policy';
  return 'No reliable improvement found';
}

function updateDescription(d: PolicyDraft) {
  if (
    ['development', 'validation', 'test'].includes(d.status) &&
    d.progress?.totalChecks &&
    d.progress.completedChecks >= d.progress.totalChecks
  )
    return 'The checks have finished. Reviewing the results before the next step. Your current policy stays active.';
  const activity: Record<string, string> = {
    queued:
      d.optimization && d.optimization.attempt > 1
        ? 'Waiting to refine the wording using the previous test results.'
        : 'Your feedback is saved. Waiting to start drafting the update.',
    drafting:
      d.optimization && d.optimization.attempt > 1
        ? 'Revising the policy using the mistakes found in the previous checks.'
        : 'Writing a policy update from your feedback.',
    preparing: 'Selecting labelled messages to test the update fairly.',
    development: 'Checking that the update fixes your feedback and preserves correct decisions.',
    validation: 'Checking the update on fresh messages it has not learned from.',
    test: 'Running the final independent check before asking for your approval.',
  };
  if (activity[d.status]) return `${activity[d.status]} Your current policy stays active.`;
  if (d.status === 'ready')
    return 'The update improved results on your labelled messages and passed a fresh final check.';
  if (d.status === 'published')
    return 'The new policy is in Observe. Review its live decisions, then enable Enforce in Settings when you are ready.';
  if (d.status === 'needs_examples')
    return 'We need more independently labelled messages to check this change fairly. Keep adding feedback; your current policy stays active.';
  if (d.status === 'failed')
    return 'The improvement run could not finish. Your feedback and progress are saved, and your current policy stays active.';
  if (d.status === 'stale')
    return 'This update was based on earlier settings. New feedback will use your current policy.';
  if (['draft', 'validated'].includes(d.status))
    return 'Let the system test this change and refine it using the results.';
  return 'The changes did not produce a consistent improvement. Your current policy stays active. New feedback or a clearer policy instruction can guide the next update.';
}

export function PolicyImprovement({
  chatId,
  onPublished,
}: {
  chatId: string;
  onPublished: () => Promise<void>;
}) {
  const api = useMemo(() => apiForGroup(chatId), [chatId]);
  const [data, setData] = useState<ImprovementOverview | null>(null),
    [error, setError] = useState(''),
    [actionErrors, setActionErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(''),
    [instruction, setInstruction] = useState('');
  const load = useCallback(async () => {
    setData(await api<ImprovementOverview>('/improvement?view=summary'));
    setError('');
  }, [api]);
  const active = data?.drafts.some((d) => working.includes(d.status));
  useVisiblePoll(load, active ? 5000 : 30000, (e) => setError(e.message));
  const dismiss = (key: string) => setActionErrors((previous) => ({ ...previous, [key]: '' }));
  const action = async (key: string, path: string, body: unknown = {}, published = false) => {
    setBusy(key);
    dismiss(key);
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      await load();
      if (published) await onPublished();
      return true;
    } catch (e) {
      setActionErrors((previous) => ({
        ...previous,
        [key]: e instanceof Error ? e.message : 'Please try again.',
      }));
      return false;
    } finally {
      setBusy('');
    }
  };
  const current = data?.drafts.find((d) => d.status !== 'discarded');
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LEARNING FROM YOUR FEEDBACK</div>
          <h1>Your policy keeps learning.</h1>
          <p>Feedback becomes a tested improvement automatically. You decide when it goes live.</p>
        </div>
      </div>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {!data && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> Loading your policy…
        </p>
      )}
      {data && !current && (
        <section className="panel improvement-intro">
          <h2>Learning from your feedback</h2>
          <p>
            Correct messages using “Add reasoned feedback”. Related corrections create an update,
            which is tested and refined automatically before it is offered for your approval.
          </p>
        </section>
      )}
      {current && (
        <section className="panel policy-draft policy-update" aria-live="polite">
          <div className="policy-update-heading">
            {working.includes(current.status) && <LoaderCircle size={24} className="spin" />}
            {current.status === 'ready' && <Check size={24} />}
            <h2>{updateTitle(current)}</h2>
          </div>
          <p
            className="policy-update-description"
            role={working.includes(current.status) ? 'status' : undefined}
          >
            {updateDescription(current)}
          </p>
          <ImprovementProgress draft={current} />
          {['ready', 'published'].includes(current.status) && Boolean(current.criteria?.length) && (
            <ul className="policy-change-summary">
              {current.criteria!.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          )}
          {current.status === 'ready' && (
            <>
              <details className="policy-test-details">
                <summary>Review proposed policy</summary>
                <pre className="policy-proposed-text">{current.candidate}</pre>
              </details>
              <p className="policy-update-description">
                Approval starts this policy in Observe so you can review live decisions before
                enabling Enforce.
              </p>
            </>
          )}
          <div className="policy-actions">
            {current.status === 'ready' && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() =>
                  void digest(current.candidate).then((hash) =>
                    action(
                      current.id,
                      `/improvement/${current.id}/publish`,
                      {
                        expectedParent: current.parent,
                        candidateHash: hash,
                        acknowledgeTradeoffs: true,
                      },
                      true,
                    ),
                  )
                }
              >
                <Check size={16} /> Approve update
              </button>
            )}
            {['draft', 'rejected'].includes(current.status) && !current.optimization && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => void action(current.id, `/improvement/${current.id}/optimize`)}
              >
                Improve automatically
              </button>
            )}
            {current.status === 'validated' && (
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => void action(current.id, `/improvement/${current.id}/test`)}
              >
                Continue improvement
              </button>
            )}
            {current.status === 'failed' && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(current.id, `/improvement/${current.id}/retry`)}
              >
                Try again
              </button>
            )}
            {current.status === 'needs_examples' && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action(current.id, `/improvement/${current.id}/optimize`)}
              >
                Check again
              </button>
            )}
            {busy === current.id && <LoaderCircle size={16} className="spin" />}
          </div>
          <ActionError message={actionErrors[current.id]} dismiss={() => dismiss(current.id)} />
        </section>
      )}
      <details className="panel improvement-clarification policy-instruction">
        <summary>Add a policy instruction</summary>
        <p>
          Describe the general rule you want the bot to follow. We’ll work out the wording and test
          the change.
        </p>
        <textarea
          aria-label="Policy instruction"
          rows={3}
          maxLength={1000}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should the bot handle differently?"
        />
        <button
          className="button secondary"
          disabled={!!busy || instruction.trim().length < 20}
          onClick={() =>
            void action('instruction', '/improvement/clarify', { clarification: instruction }).then(
              (saved) => {
                if (saved) setInstruction('');
              },
            )
          }
        >
          {busy === 'instruction' && <LoaderCircle size={16} className="spin" />} Improve policy
        </button>
        <ActionError message={actionErrors.instruction} dismiss={() => dismiss('instruction')} />
      </details>
      {Boolean(data?.versions.length) && (
        <details className="panel improvement-intro policy-history">
          <summary>Policy history</summary>
          <p>You can restore an earlier policy while keeping your current operating mode.</p>
          {data!.versions.map((version) => (
            <div className="policy-version" key={version.id}>
              <span>{new Date(version.created_at).toLocaleString()}</span>
              {version.id === data!.activeVersion ? (
                <span className="tag">Current</span>
              ) : (
                <button
                  className="button secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void action(
                      version.id,
                      '/improvement/rollback',
                      { versionId: version.id, expectedParent: data!.activeVersion },
                      true,
                    )
                  }
                >
                  <RotateCcw size={14} /> Restore policy
                </button>
              )}
              <details>
                <summary>View policy</summary>
                <pre>{version.policy}</pre>
              </details>
              <ActionError message={actionErrors[version.id]} dismiss={() => dismiss(version.id)} />
            </div>
          ))}
        </details>
      )}
    </>
  );
}
