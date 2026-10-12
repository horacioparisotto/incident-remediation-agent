import type { Tx } from '../src/plan';
import type { Findings, Incident, QueueMessage, Run, RunStatus, RunStore } from '../src/types';

/** In-memory RunStore with the same claim semantics as the MongoDB adapter. */
export class MemoryRuns implements RunStore {
  runs = new Map<string, Run>();

  async claim(incident: Pick<Incident, 'id' | 'tenantId' | 'triggeredBy'>, leaseMs: number, now: number) {
    const id = `run_${incident.id}`;
    const existing = this.runs.get(id);
    const free = !existing || existing.status === 'released' || (existing.status === 'preparing' && existing.leaseUntil < now);
    if (!free) return null;
    const run: Run = {
      id,
      incidentId: incident.id,
      tenantId: incident.tenantId,
      triggeredBy: incident.triggeredBy,
      status: 'preparing',
      leaseUntil: now + leaseMs,
      attempts: (existing?.attempts ?? 0) + 1,
    };
    this.runs.set(id, run);
    return { ...run };
  }

  async release(runId: string, error: string) {
    this.update(runId, { status: 'released', lastError: error, leaseUntil: 0 });
  }

  async saveFindings(runId: string, findings: Findings) {
    if (this.runs.get(runId)?.status === 'preparing') this.update(runId, { status: 'prepared', findings });
  }

  async setStatus(runId: string, status: RunStatus) {
    this.update(runId, { status });
  }

  async get(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return { ...run };
  }

  private update(runId: string, patch: Partial<Run>) {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, ...patch });
  }
}

export class MemoryQueue {
  published: Array<{ topic: string; payload: unknown }> = [];
  async publish(topic: string, payload: unknown) {
    this.published.push({ topic, payload });
  }
}

export function message<T>(payload: T) {
  const msg = { payload, acked: false, nacked: false } as QueueMessage<T> & { acked: boolean; nacked: boolean };
  msg.ack = async () => void (msg.acked = true);
  msg.nack = async () => void (msg.nacked = true);
  return msg;
}

/**
 * A tiny transactional store: each transaction buffers its writes and applies
 * them together on commit, or drops them all if the function throws.
 */
export class MemoryDb<S> {
  constructor(public state: S) {}
  private pending = new Map<string, Array<(s: S) => void>>();
  private next = 0;

  async withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = { id: `tx${this.next++}` };
    this.pending.set(tx.id, []);
    try {
      const result = await fn(tx);
      this.pending.get(tx.id)!.forEach((write) => write(this.state));
      return result;
    } finally {
      this.pending.delete(tx.id);
    }
  }

  write(tx: Tx, change: (s: S) => void): void {
    const writes = this.pending.get(tx.id);
    if (!writes) throw new Error('write outside a transaction');
    writes.push(change);
  }
}

export const incident = (overrides: Partial<Incident> = {}): Incident => ({
  id: 'inc-1',
  tenantId: 'tenant-1',
  externalId: 'EXT-1',
  title: 'Phishing link clicked',
  triggeredBy: 'user-7',
  status: 'open',
  ...overrides,
});
