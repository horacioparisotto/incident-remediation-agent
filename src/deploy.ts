import type { Run, RunStore, Tenant } from './types';

export interface DeployDeps {
  runs: RunStore;
  tenants: { get(id: string): Promise<Tenant> };
  buildPlan(run: Run): Promise<unknown>;
}

/**
 * Consumer of 'run.prepared'. Phase 2, deploy, builds and assigns the plan.
 * Each tenant chooses when that happens; the agent never decides its own
 * autonomy level.
 *
 * Waiting is a saved status, not a callback in memory, so a restart never
 * loses a plan that is waiting for a workflow transition or an approval.
 */
export async function afterPrepare({ runId }: { runId: string }, deps: DeployDeps): Promise<void> {
  const run = await deps.runs.get(runId);
  if (run.status !== 'prepared') return; // redelivered: already routed
  if (!run.findings?.safe) {
    // The agent said it couldn't produce a safe result: recorded, visible to
    // people, and nothing gets deployed.
    return deps.runs.setStatus(run.id, 'declined');
  }

  const tenant = await deps.tenants.get(run.tenantId);
  switch (tenant.deployTrigger) {
    case 'automatic':
      return deploy(run.id, deps);
    case 'on_transition':
      // Deployed later by the workflow-transition handler.
      return deps.runs.setStatus(run.id, 'awaiting_transition');
    case 'manual':
      // Deployed when someone approves it on the review page.
      return deps.runs.setStatus(run.id, 'awaiting_approval');
    default:
      throw new Error(`Unknown deploy trigger for tenant ${tenant.id}`);
  }
}

/** Resumes from what prepare saved; never re-runs the judgment. */
export async function deploy(runId: string, deps: DeployDeps): Promise<void> {
  const run = await deps.runs.get(runId);
  if (run.status === 'deployed') return;
  await deps.buildPlan(run);
  await deps.runs.setStatus(run.id, 'deployed');
}
