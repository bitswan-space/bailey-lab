import { toast } from 'sonner';
import { api, isTransientNetworkError, type DeployStatusResponse } from './api';

const POLL_INTERVAL_MS = 3000;
// Generous ceiling: a BP deploy builds member images sequentially (gitops
// caps each image build at 5 minutes), so several members can legitimately
// take a while. The loop is a cheap GET every few seconds.
const TIMEOUT_MS = 30 * 60_000;
// Consecutive poll failures before giving up (gitops restarted and forgot
// the task, auth broke, …).
const MAX_POLL_FAILURES = 5;

export type BpDeployOutcome = 'completed' | 'failed' | 'timeout' | 'lost';

export interface DeployToastCopy {
  loading: string;
  success: string;
  failurePrefix: string;
}

/**
 * Watch an already-started gitops deploy task and surface its progress in a
 * single updating toast: loading → live step messages → success/error.
 * Resolves with the terminal outcome.
 *
 * Used both by `deployBpWithToast` (explicit BP deploys) and by the
 * create-BP / create-worktree flows, whose responses carry a
 * `deploy_task_id` for the server-side auto-deploy.
 *
 * Progress comes from polling gitops's `deploy-status/{task_id}` endpoint
 * (via the server proxy), deliberately NOT from the `deploy_progress` SSE
 * event: that event is fire-and-forget — a dropped stream loses the terminal
 * event and would leave the UI stuck "deploying" forever.
 */
export async function watchDeployTask(
  taskId: string,
  toastId: string,
  copy: DeployToastCopy,
): Promise<BpDeployOutcome> {
  toast.loading(copy.loading, { id: toastId, duration: Infinity });

  const deadline = Date.now() + TIMEOUT_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let status: DeployStatusResponse;
    try {
      status = await api.deployStatus(taskId);
      failures = 0;
    } catch {
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        toast.error(
          `${copy.failurePrefix}: lost track of the deploy task — check the cards for the real state`,
          { id: toastId, duration: 8000 },
        );
        return 'lost';
      }
      continue;
    }
    if (status.status === 'completed') {
      toast.success(copy.success, { id: toastId, duration: 5000 });
      return 'completed';
    }
    if (status.status === 'failed') {
      toast.error(
        `${copy.failurePrefix}: ${status.error || status.message || 'deployment failed'}`,
        { id: toastId, duration: 10000 },
      );
      return 'failed';
    }
    if (status.message) {
      toast.loading(status.message, { id: toastId, duration: Infinity });
    }
  }

  toast.error(`${copy.failurePrefix}: timed out waiting for deploy status`, {
    id: toastId,
    duration: 8000,
  });
  return 'timeout';
}

/**
 * Kick off a whole-BP deploy and watch it via `watchDeployTask`. Resolves
 * with the terminal outcome so callers can clear their busy state.
 */
export async function deployBpWithToast(opts: {
  bp: string;
  stage: 'dev' | 'live-dev';
  worktree?: string;
  /** Toast copy. */
  loading: string;
  success: string;
  failurePrefix: string;
}): Promise<BpDeployOutcome> {
  const toastId = `bp-deploy-${opts.worktree ?? 'main'}-${opts.bp}`;
  toast.loading(opts.loading, { id: toastId, duration: Infinity });

  let taskId: string;
  try {
    const res = await api.deployBusinessProcess({
      bp: opts.bp,
      stage: opts.stage,
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
    });
    taskId = res.task_id;
    if (!taskId) throw new Error('gitops returned no task_id');
  } catch (err) {
    if (isTransientNetworkError(err)) {
      // The request likely reached gitops but the response was lost in a
      // Traefik route blip — without a task_id there is nothing to poll, so
      // stop the toast; the SSE automations snapshot shows the real state.
      toast.info(
        `${opts.bp}: deploy request sent — connection blipped, watch the cards for status`,
        { id: toastId, duration: 8000 },
      );
      return 'lost';
    }
    toast.error(`${opts.failurePrefix}: ${String(err)}`, {
      id: toastId,
      duration: 8000,
    });
    return 'failed';
  }

  return watchDeployTask(taskId, toastId, {
    loading: opts.loading,
    success: opts.success,
    failurePrefix: opts.failurePrefix,
  });
}
