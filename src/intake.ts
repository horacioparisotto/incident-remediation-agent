import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Incident, Queue, Tenant } from './types';

export const IncidentSchema = z.object({
  externalId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  reportedBy: z.string().email(),
});

export interface IntakeDeps {
  tenantByKeyHash(hash: string): Promise<Tenant | null>;
  /** Deduplicate and persist in one atomic step (unique index on tenant + external id). */
  upsertIncident(tenantId: string, data: z.infer<typeof IncidentSchema>): Promise<Incident>;
  queue: Queue;
}

export interface HttpRequest {
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
}

/**
 * Incidents arrive on their own authenticated endpoint, with a hashed key per
 * tenant rather than the shared webhook path. The request does only what has
 * to happen now: authenticate, validate, deduplicate, persist. Everything
 * heavier (triage, the agent run) goes on a durable queue, so the reporting
 * system gets an answer right away whether or not the AI is busy.
 */
export function createIntake(deps: IntakeDeps) {
  return async function intake(req: HttpRequest): Promise<HttpResponse> {
    const key = req.headers['x-api-key'] ?? '';
    const tenant = key ? await deps.tenantByKeyHash(sha256(key)) : null;
    if (!tenant) return { status: 401 };

    const parsed = IncidentSchema.safeParse(req.body);
    if (!parsed.success) {
      // A clear error without echoing the schema back.
      return { status: 422, body: { error: 'invalid_incident' } };
    }

    // A retried report returns the same incident, never a second one.
    const incident = await deps.upsertIncident(tenant.id, parsed.data);

    // Downstream, an atomic claim makes a redelivered message a no-op, so
    // publishing again on a retry is safe.
    await deps.queue.publish('incident.received', { incidentId: incident.id });
    return { status: 202, body: { id: incident.id } };
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
