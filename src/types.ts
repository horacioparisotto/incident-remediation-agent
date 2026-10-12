// Domain types and the ports the agent's code depends on. Production adapters
// live in mongo.ts; tests use in-memory implementations.

export interface Tenant {
  id: string;
  deployTrigger: DeployTrigger;
}

/** How autonomous the agent is, chosen per tenant. The agent never decides this itself. */
export type DeployTrigger = 'automatic' | 'on_transition' | 'manual';

export interface Incident {
  id: string;
  tenantId: string;
  externalId: string;
  title: string;
  triggeredBy: string; // the identity every agent action runs as
  status: 'open' | 'closed';
}

export interface Gap {
  controlId: string;
  description: string;
}

export interface Findings {
  incidentId: string;
  safe: boolean; // false: the agent says so instead of inventing a result
  reason?: string;
  gaps: Gap[];
}

export type RunStatus =
  | 'preparing'
  | 'released' // a failed attempt; claimable again
  | 'prepared'
  | 'declined' // the agent couldn't produce a safe result, and said so
  | 'awaiting_transition'
  | 'awaiting_approval'
  | 'deployed';

export interface Run {
  id: string;
  incidentId: string;
  tenantId: string;
  triggeredBy: string;
  status: RunStatus;
  leaseUntil: number;
  attempts: number;
  findings?: Findings;
  lastError?: string;
}

export interface RunStore {
  /**
   * Atomically claims the run for an incident. Returns null when another
   * worker holds a live lease, or the run is already past preparation.
   */
  claim(incident: Pick<Incident, 'id' | 'tenantId' | 'triggeredBy'>, leaseMs: number, now: number): Promise<Run | null>;
  release(runId: string, error: string): Promise<void>;
  saveFindings(runId: string, findings: Findings): Promise<void>;
  setStatus(runId: string, status: RunStatus): Promise<void>;
  get(runId: string): Promise<Run>;
}

export interface Queue {
  publish(topic: 'incident.received', payload: { incidentId: string }): Promise<void>;
  publish(topic: 'run.prepared', payload: { runId: string }): Promise<void>;
}

export interface QueueMessage<T> {
  payload: T;
  ack(): Promise<void>;
  nack(): Promise<void>;
}
