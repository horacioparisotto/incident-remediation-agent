import type { Incident } from './types';
import type { Tx } from './plan';

export interface Actor {
  id: string;
}

export class ClosureBlocked extends Error {
  constructor(readonly blockers: string[]) {
    super(`Incident has ${blockers.length} open item(s)`);
  }
}

export interface ClosureDeps {
  withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  incidents: {
    get(tx: Tx, id: string): Promise<Incident>;
    close(tx: Tx, id: string, by: string): Promise<void>;
  };
  tasks: { open(tx: Tx, incidentId: string): Promise<Array<{ id: string }>> };
  training: {
    incomplete(tx: Tx, incidentId: string): Promise<Array<{ id: string; waivedBy?: string }>>;
  };
  permissions: { require(tx: Tx, actor: Actor, action: 'close', incident: Incident): Promise<void> };
}

/**
 * An incident can't be closed while it has open tasks or unfinished training,
 * unless that training was explicitly waived rather than silently skipped.
 *
 * The rule lives inside the one transactional operation every caller goes
 * through, including the agent itself, and in this service's domain layer
 * rather than the library other services share, where any consumer could
 * reach around it. Reading inside the transaction means a concurrent change to
 * the incident aborts one of the two.
 */
export function closeIncident(id: string, actor: Actor, deps: ClosureDeps): Promise<void> {
  return deps.withTransaction(async (tx) => {
    const incident = await deps.incidents.get(tx, id);
    await deps.permissions.require(tx, actor, 'close', incident);
    if (incident.status === 'closed') return;

    const blockers = [
      ...(await deps.tasks.open(tx, id)),
      ...(await deps.training.incomplete(tx, id)).filter((t) => !t.waivedBy),
    ];
    if (blockers.length > 0) throw new ClosureBlocked(blockers.map((b) => b.id));

    await deps.incidents.close(tx, id, actor.id);
  });
}
