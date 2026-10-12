import type { Gap, Run } from './types';

export interface Tx {
  readonly id: string;
}

export interface PlanDeps {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  plans: {
    createDraft(incidentId: string, actAs: string): Promise<{ id: string }>;
    linkSkill(tx: Tx, planId: string, skillId: string): Promise<void>;
    recordResults(planId: string, results: PromiseSettledResult<unknown>[]): Promise<void>;
    publishAndAssign(planId: string, actAs: string): Promise<void>;
    delete(planId: string): Promise<void>;
  };
  skills: {
    create(tx: Tx, draft: SkillDraft, by: string): Promise<{ id: string }>;
    publish(tx: Tx, skillId: string): Promise<void>;
  };
  /** The LLM writes the missing skill's content. */
  writeSkill(gap: Gap): Promise<SkillDraft>;
}

export interface SkillDraft {
  title: string;
  content: string;
}

/**
 * Builds the remediation plan from saved findings. The plan is the same
 * training-plan type the platform already used, so publishing, assigning and
 * reviewing it needed no new infrastructure.
 *
 * One gap failing to generate never blocks the rest. If building the plan
 * fails partway, the agent deletes what it started: no half-built record is
 * left behind.
 */
export async function buildPlan(run: Run, deps: PlanDeps): Promise<string> {
  const gaps = run.findings?.gaps ?? [];
  const plan = await deps.plans.createDraft(run.incidentId, run.triggeredBy);
  try {
    const results = await Promise.allSettled(gaps.map((gap) => addSkill(plan.id, gap, run.triggeredBy, deps)));
    await deps.plans.recordResults(plan.id, results);
    await deps.plans.publishAndAssign(plan.id, run.triggeredBy);
    return plan.id;
  } catch (err) {
    // Skills already published stay: each one is complete and reusable from
    // the catalog. Only the half-built plan goes.
    await deps.plans.delete(plan.id);
    throw err;
  }
}

/**
 * When no published skill covers a gap, the agent writes the missing one.
 * Creating it, publishing it and linking it to the plan are one transaction:
 * fully applied or not applied at all, never a skill with no content behind it.
 */
async function addSkill(planId: string, gap: Gap, actAs: string, deps: PlanDeps) {
  const draft = await deps.writeSkill(gap);
  return deps.withTransaction(async (tx) => {
    const skill = await deps.skills.create(tx, draft, actAs);
    await deps.skills.publish(tx, skill.id);
    await deps.plans.linkSkill(tx, planId, skill.id);
    return skill;
  });
}
