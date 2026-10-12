// MongoDB adapters for the ports in types.ts and plan.ts. Not exercised by the
// test suite, which uses in-memory implementations with the same contracts;
// running them needs a MongoDB replica set (transactions require one).
import { MongoServerError, type ClientSession, type Db, type MongoClient } from 'mongodb';
import type { Tx } from './plan';
import type { Findings, Run, RunStatus, RunStore } from './types';

type RunDoc = Omit<Run, 'id'> & { _id: string };

/** Requires a unique index on { incidentId: 1 }. */
export function mongoRunStore(db: Db): RunStore {
  const runs = db.collection<RunDoc>('remediation_runs');
  const toRun = ({ _id, ...rest }: RunDoc): Run => ({ id: _id, ...rest });

  return {
    async claim(incident, leaseMs, now) {
      try {
        // Matches only a run that is free to take: a released one, or one whose
        // worker's lease expired. Otherwise the upsert tries to insert a second
        // run for the incident and the unique index rejects it: not ours.
        const doc = await runs.findOneAndUpdate(
          {
            incidentId: incident.id,
            $or: [{ status: 'released' }, { status: 'preparing', leaseUntil: { $lt: now } }],
          },
          {
            $set: { status: 'preparing', leaseUntil: now + leaseMs },
            $inc: { attempts: 1 },
            $setOnInsert: {
              _id: `run_${incident.id}`,
              tenantId: incident.tenantId,
              triggeredBy: incident.triggeredBy,
            },
          },
          { upsert: true, returnDocument: 'after' },
        );
        return doc ? toRun(doc) : null;
      } catch (err) {
        if (err instanceof MongoServerError && err.code === 11000) return null;
        throw err;
      }
    },
    async release(runId, error) {
      await runs.updateOne({ _id: runId }, { $set: { status: 'released', lastError: error, leaseUntil: 0 } });
    },
    async saveFindings(runId, findings: Findings) {
      await runs.updateOne({ _id: runId, status: 'preparing' }, { $set: { status: 'prepared', findings } });
    },
    async setStatus(runId, status: RunStatus) {
      await runs.updateOne({ _id: runId }, { $set: { status } });
    },
    async get(runId) {
      const doc = await runs.findOne({ _id: runId });
      if (!doc) throw new Error(`Run not found: ${runId}`);
      return toRun(doc);
    },
  };
}

export interface MongoTx extends Tx {
  session: ClientSession;
}

/** Runs `fn` in a multi-document transaction, retried by the driver on transient errors. */
export function mongoTransactions(client: MongoClient) {
  return async function withTransaction<T>(fn: (tx: MongoTx) => Promise<T>): Promise<T> {
    const session = client.startSession();
    try {
      return await session.withTransaction(() => fn({ id: session.id?.id.toString('hex') ?? 'tx', session }));
    } finally {
      await session.endSession();
    }
  };
}
