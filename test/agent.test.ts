import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { ClosureBlocked, closeIncident, type ClosureDeps } from '../src/closure';
import { afterPrepare, deploy, type DeployDeps } from '../src/deploy';
import { createIntake, sha256 } from '../src/intake';
import { createAgentServer, type PlatformApi } from '../src/mcp';
import { buildPlan, type PlanDeps } from '../src/plan';
import type { DeployTrigger, Findings, Gap, Queue } from '../src/types';
import { LEASE_MS, onIncidentReceived, type WorkerDeps } from '../src/worker';
import { incident, MemoryDb, MemoryQueue, MemoryRuns, message } from './fakes';

const SAFE: Findings = { incidentId: 'inc-1', safe: true, gaps: [{ controlId: 'c1', description: 'phishing' }] };

describe('intake', () => {
  function setup() {
    const queue = new MemoryQueue();
    const stored = new Map<string, string>();
    const intake = createIntake({
      tenantByKeyHash: async (hash) => (hash === sha256('key-1') ? { id: 'tenant-1', deployTrigger: 'automatic' } : null),
      upsertIncident: async (tenantId, data) => {
        const key = `${tenantId}|${data.externalId}`;
        if (!stored.has(key)) stored.set(key, `inc-${stored.size + 1}`);
        return incident({ id: stored.get(key)!, tenantId, externalId: data.externalId });
      },
      queue: queue as unknown as Queue,
    });
    return { intake, queue };
  }
  const body = { externalId: 'EXT-1', title: 'Phishing link clicked', reportedBy: 'ana@example.com' };

  it('rejects unknown keys and invalid payloads without echoing the schema', async () => {
    const { intake } = setup();

    expect(await intake({ headers: { 'x-api-key': 'nope' }, body })).toEqual({ status: 401 });
    expect(await intake({ headers: { 'x-api-key': 'key-1' }, body: { title: 'x' } })).toEqual({
      status: 422,
      body: { error: 'invalid_incident' },
    });
  });

  it('accepts fast and turns a retried report into the same incident', async () => {
    const { intake, queue } = setup();

    const first = await intake({ headers: { 'x-api-key': 'key-1' }, body });
    const retry = await intake({ headers: { 'x-api-key': 'key-1' }, body });

    expect(first).toEqual({ status: 202, body: { id: 'inc-1' } });
    expect(retry).toEqual(first);
    expect(queue.published.every((m) => m.topic === 'incident.received')).toBe(true);
  });
});

describe('idempotent runs', () => {
  function setup(prepare: WorkerDeps['prepare'] = async () => SAFE) {
    let now = 1_000;
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const deps: WorkerDeps = {
      runs,
      queue: queue as unknown as Queue,
      incidents: { get: async (id) => incident({ id }) },
      prepare: vi.fn(prepare),
      now: () => now,
    };
    return { deps, runs, queue, advance: (ms: number) => (now += ms) };
  }

  it('runs once even when the message is delivered twice', async () => {
    const { deps, queue } = setup();
    const first = message({ incidentId: 'inc-1' });
    const again = message({ incidentId: 'inc-1' });

    await onIncidentReceived(first, deps);
    await onIncidentReceived(again, deps);

    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect(first.acked && again.acked).toBe(true);
    expect(queue.published).toEqual([{ topic: 'run.prepared', payload: { runId: 'run_inc-1' } }]);
  });

  it('acts as the triggering identity, never its own', async () => {
    const { deps } = setup();
    await onIncidentReceived(message({ incidentId: 'inc-1' }), deps);

    expect(deps.prepare).toHaveBeenCalledWith(expect.anything(), { actAs: 'user-7' });
  });

  it('releases the claim on failure so the redelivered message retries', async () => {
    const { deps, runs } = setup(vi.fn().mockRejectedValueOnce(new Error('model timeout')).mockResolvedValue(SAFE));
    const failed = message({ incidentId: 'inc-1' });

    await onIncidentReceived(failed, deps);
    expect(failed.nacked).toBe(true);
    expect((await runs.get('run_inc-1')).status).toBe('released');

    await onIncidentReceived(message({ incidentId: 'inc-1' }), deps);
    expect((await runs.get('run_inc-1')).status).toBe('prepared');
  });

  it("takes over a crashed worker's run once its lease expires", async () => {
    const { deps, runs, advance } = setup();
    await runs.claim(incident(), LEASE_MS, 1_000); // a worker that then died

    const early = message({ incidentId: 'inc-1' });
    await onIncidentReceived(early, deps);
    expect(deps.prepare).not.toHaveBeenCalled();

    advance(LEASE_MS + 1);
    await onIncidentReceived(message({ incidentId: 'inc-1' }), deps);
    expect(deps.prepare).toHaveBeenCalledTimes(1);
    expect((await runs.get('run_inc-1')).attempts).toBe(2);
  });
});

describe('tenant-controlled autonomy', () => {
  async function prepared(trigger: DeployTrigger, findings: Findings = SAFE) {
    const runs = new MemoryRuns();
    await runs.claim(incident(), LEASE_MS, 0);
    await runs.saveFindings('run_inc-1', findings);
    const deps: DeployDeps = {
      runs,
      tenants: { get: async (id) => ({ id, deployTrigger: trigger }) },
      buildPlan: vi.fn(async () => 'plan-1'),
    };
    return { runs, deps };
  }

  it.each([
    ['automatic', 'deployed', 1],
    ['on_transition', 'awaiting_transition', 0],
    ['manual', 'awaiting_approval', 0],
  ] as const)('%s → %s', async (trigger, status, builds) => {
    const { runs, deps } = await prepared(trigger);

    await afterPrepare({ runId: 'run_inc-1' }, deps);
    await afterPrepare({ runId: 'run_inc-1' }, deps); // redelivered

    expect((await runs.get('run_inc-1')).status).toBe(status);
    expect(deps.buildPlan).toHaveBeenCalledTimes(builds);
  });

  it('a waiting run deploys from the saved findings when approved', async () => {
    const { runs, deps } = await prepared('manual');
    await afterPrepare({ runId: 'run_inc-1' }, deps);

    await deploy('run_inc-1', deps);

    expect(deps.buildPlan).toHaveBeenCalledWith(expect.objectContaining({ findings: SAFE }));
    expect((await runs.get('run_inc-1')).status).toBe('deployed');
  });

  it('records an unsafe result instead of deploying anything', async () => {
    const { runs, deps } = await prepared('automatic', { incidentId: 'inc-1', safe: false, reason: 'ambiguous', gaps: [] });

    await afterPrepare({ runId: 'run_inc-1' }, deps);

    expect((await runs.get('run_inc-1')).status).toBe('declined');
    expect(deps.buildPlan).not.toHaveBeenCalled();
  });
});

describe('all or nothing plans', () => {
  type State = { plans: Record<string, { skills: string[]; published: boolean }>; skills: Record<string, { published: boolean }> };

  function setup(opts: { failGap?: string; failLink?: string; failPublish?: boolean } = {}) {
    const db = new MemoryDb<State>({ plans: {}, skills: {} });
    let n = 0;
    const deps: PlanDeps = {
      withTransaction: (fn) => db.withTransaction(fn),
      writeSkill: async (gap: Gap) => {
        if (gap.controlId === opts.failGap) throw new Error('generation failed');
        return { title: gap.controlId, content: '…' };
      },
      skills: {
        create: async (tx, draft) => {
          const id = `skill-${draft.title}`;
          db.write(tx, (s) => void (s.skills[id] = { published: false }));
          return { id };
        },
        publish: async (tx, id) => db.write(tx, (s) => void (s.skills[id]!.published = true)),
      },
      plans: {
        createDraft: async () => {
          const id = `plan-${++n}`;
          db.state.plans[id] = { skills: [], published: false };
          return { id };
        },
        linkSkill: async (tx, planId, skillId) => {
          if (skillId === `skill-${opts.failLink}`) throw new Error('link failed');
          db.write(tx, (s) => void s.plans[planId]!.skills.push(skillId));
        },
        recordResults: async () => {},
        publishAndAssign: async (planId) => {
          if (opts.failPublish) throw new Error('assign failed');
          db.state.plans[planId]!.published = true;
        },
        delete: async (planId) => void delete db.state.plans[planId],
      },
    };
    const run = { id: 'r', incidentId: 'inc-1', tenantId: 't', triggeredBy: 'user-7', status: 'prepared' as const, leaseUntil: 0, attempts: 1 };
    const gaps = ['c1', 'c2', 'c3'].map((controlId) => ({ controlId, description: '' }));
    return { db, deps, run: { ...run, findings: { incidentId: 'inc-1', safe: true, gaps } } };
  }

  it('one gap failing to generate never blocks the rest', async () => {
    const { db, deps, run } = setup({ failGap: 'c2' });

    await buildPlan(run, deps);

    expect(db.state.plans['plan-1']).toEqual({ skills: ['skill-c1', 'skill-c3'], published: true });
  });

  it('never leaves a skill half-created: create, publish and link commit together', async () => {
    const { db, deps, run } = setup({ failLink: 'c2' });

    await buildPlan(run, deps);

    expect(Object.keys(db.state.skills).sort()).toEqual(['skill-c1', 'skill-c3']);
  });

  it('deletes the plan it started when building it fails', async () => {
    const { db, deps, run } = setup({ failPublish: true });

    await expect(buildPlan(run, deps)).rejects.toThrow('assign failed');
    expect(db.state.plans).toEqual({});
  });
});

describe('closure gate', () => {
  function setup(state: { tasks?: string[]; training?: Array<{ id: string; waivedBy?: string }>; allowed?: boolean }) {
    const db = new MemoryDb({ status: 'open' as 'open' | 'closed' });
    const deps: ClosureDeps = {
      withTransaction: (fn) => db.withTransaction(fn),
      incidents: {
        get: async () => incident({ status: db.state.status }),
        close: async (tx) => db.write(tx, (s) => void (s.status = 'closed')),
      },
      tasks: { open: async () => (state.tasks ?? []).map((id) => ({ id })) },
      training: { incomplete: async () => state.training ?? [] },
      permissions: {
        require: async () => {
          if (state.allowed === false) throw new Error('forbidden');
        },
      },
    };
    return { db, deps };
  }

  it('blocks closing with open tasks or unfinished training', async () => {
    const { db, deps } = setup({ tasks: ['t1'], training: [{ id: 'tr1' }] });

    await expect(closeIncident('inc-1', { id: 'agent-as-user-7' }, deps)).rejects.toEqual(new ClosureBlocked(['t1', 'tr1']));
    expect(db.state.status).toBe('open');
  });

  it('allows training that was explicitly waived, not silently skipped', async () => {
    const { db, deps } = setup({ training: [{ id: 'tr1', waivedBy: 'manager-2' }] });

    await closeIncident('inc-1', { id: 'user-7' }, deps);

    expect(db.state.status).toBe('closed');
  });

  it('checks permissions for every caller, the agent included', async () => {
    const { db, deps } = setup({ allowed: false });

    await expect(closeIncident('inc-1', { id: 'user-7' }, deps)).rejects.toThrow('forbidden');
    expect(db.state.status).toBe('open');
  });
});

describe('MCP tools', () => {
  const api: PlatformApi = {
    incidents: {
      get: async (id) => ({ id, title: 'Phishing', controlIds: ['c1'], involved: [{ email: 'ana@example.com' }, { email: 'gone@example.com' }] }),
    },
    controls: { get: async (id) => ({ id, title: 'Security awareness' }) },
    users: { findByEmail: async (email) => (email === 'ana@example.com' ? { id: 'u1', name: 'Ana', email } : null) },
    skills: { listPublished: async () => [] },
  };

  async function connect(token?: string) {
    const tokens: string[] = [];
    const server = createAgentServer((t) => {
      tokens.push(t);
      return api;
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    if (token) {
      const send = clientSide.send.bind(clientSide);
      clientSide.send = (msg, opts) => send(msg, { ...opts, authInfo: { token, clientId: 'agent', scopes: [] } });
    }
    await server.connect(serverSide);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientSide);
    return { client, tokens };
  }

  it('exposes four narrow, read-only tools', async () => {
    const { client } = await connect('session-of-user-7');
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['get_control', 'get_incident', 'list_skills', 'resolve_people']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("calls the platform with the triggering user's session and returns only public fields", async () => {
    const { client, tokens } = await connect('session-of-user-7');

    const result = await client.callTool({ name: 'resolve_people', arguments: { incidentId: 'inc-1' } });

    expect(tokens).toEqual(['session-of-user-7']);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([{ id: 'u1', name: 'Ana' }]) }]);
  });

  it('refuses to run without a session', async () => {
    const { client, tokens } = await connect();

    const result = await client.callTool({ name: 'get_incident', arguments: { incidentId: 'inc-1' } });

    expect(result.isError).toBe(true);
    expect(tokens).toEqual([]);
  });
});
