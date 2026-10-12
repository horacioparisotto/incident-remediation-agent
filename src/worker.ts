import type { Findings, Incident, Queue, QueueMessage, RunStore } from './types';

export const LEASE_MS = 10 * 60_000;

export interface WorkerDeps {
  runs: RunStore;
  queue: Queue;
  incidents: { get(id: string): Promise<Incident> };
  /** Phase 1: judge with read-only tools, acting as the triggering identity. */
  prepare(incident: Incident, opts: { actAs: string }): Promise<Findings>;
  now(): number;
}

/**
 * Consumer of 'incident.received'.
 *
 * The claim is atomic, so a redelivered message is a no-op, and it carries a
 * lease: if this worker crashes mid-run, the lease expires and another worker
 * picks the work up instead of the incident staying stuck forever. If prepare
 * fails, the claim is released and the message redelivered, so the work is
 * retried rather than lost.
 *
 * Deploy is its own durable step ('run.prepared'), never a follow-up call that
 * could be lost if this process dies after acknowledging the message.
 */
export async function onIncidentReceived(msg: QueueMessage<{ incidentId: string }>, deps: WorkerDeps) {
  const incident = await deps.incidents.get(msg.payload.incidentId);
  const run = await deps.runs.claim(incident, LEASE_MS, deps.now());
  if (!run) return msg.ack(); // already handled, or in progress elsewhere

  try {
    const findings = await deps.prepare(incident, { actAs: incident.triggeredBy });
    await deps.runs.saveFindings(run.id, findings);
    await deps.queue.publish('run.prepared', { runId: run.id });
  } catch (err) {
    await deps.runs.release(run.id, err instanceof Error ? err.message : String(err));
    return msg.nack();
  }
  await msg.ack();
}
