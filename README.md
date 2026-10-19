# incident-remediation-agent

[![CI](https://github.com/horacioparisotto/incident-remediation-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/horacioparisotto/incident-remediation-agent/actions/workflows/ci.yml)

Patterns from the remediation agent I designed with the CTO of **[StackFactor](https://stackfactor.ai/shield)**, a US platform for SDLC compliance, and shipped to production. When a SHIELD deployment gate blocks a non-compliant release, the agent turns the incident into a finished, assigned EXCEED training plan for the people involved, with no human writing a word of it. Every action runs under the identity of whoever triggered it, nothing is ever left half-created, and when it can't produce a safe result it says so instead of inventing one.

> **Rewritten from scratch to protect client code.** This is not the production source: names, schemas and infrastructure are replaced. The domain code depends on small ports; [`src/mongo.ts`](src/mongo.ts) implements them on MongoDB, and the tests use in-memory implementations with the same contracts. The MCP tools are tested end to end with the official MCP SDK client.

**Guarantees:** 0 standing credentials · 0 direct database access · 0 duplicate runs · same-day remediation.
Full case study: [horacioparisotto.com](https://www.horacioparisotto.com/)

```bash
npm ci && npm test
```

## Patterns

### 1. A thin intake, heavy work on a queue · [`src/intake.ts`](src/intake.ts)

Incidents arrive on a dedicated authenticated endpoint with a hashed key per tenant, instead of the shared webhook path. The request does only what has to happen now (authenticate, validate, deduplicate, persist) and everything heavier goes on a durable queue. A retried report returns the same incident, never a second one.

### 2. Idempotent runs that can fail safely · [`src/worker.ts`](src/worker.ts)

A listener claims each incident atomically before the agent runs, so a redelivered message is a no-op. The claim carries a lease: if a worker crashes mid-run, another one takes over when the lease expires. The first phase, prepare, only judges with read-only tools and records findings; if it fails, the claim is released and the message redelivered. Deploy is its own durable message, never a follow-up call that could be lost.

### 3. The tenant decides how autonomous it is · [`src/deploy.ts`](src/deploy.ts)

The second phase, deploy, builds and assigns the plan, and each tenant chooses when: automatically, on a workflow transition, or only on manual approval. The agent never decides its own autonomy level. Waiting is a saved status, not a callback in memory, so a restart never loses a plan waiting for approval, and deploy resumes from the saved findings instead of judging again. An unsafe result is recorded as declined and nothing is deployed.

### 4. Narrow tools instead of database access · [`src/mcp.ts`](src/mcp.ts)

The agent reaches the platform the way an outside tool would: four named, read-only MCP tools, each call carrying the forwarded session token of whoever triggered the incident. A tool can only do what its caller could do by hand, and without a session it refuses to run. Tools orchestrate several API calls behind them, so the surface reflects what the agent needs to decide rather than mirroring the API.

### 5. All or nothing, and nothing half-built · [`src/plan.ts`](src/plan.ts)

When no published skill covers what caused an incident, the agent writes the missing one. Creating it, publishing it and linking it to the plan happen in one transaction. One gap failing to generate never blocks the rest, and if building the plan fails partway, the agent deletes what it started. The plan reuses the platform's existing training-plan type, so publishing, assigning and reviewing it needed no new infrastructure.

### 6. A closure gate nothing can skip · [`src/closure.ts`](src/closure.ts)

An incident can't be closed while it has open tasks or unfinished training, unless that training was explicitly waived rather than silently skipped. The rule runs inside the one transactional operation every caller goes through, the agent included, and lives in this service's domain layer rather than the library other services share, where any consumer could reach around it.

---

Horacio Parisotto · Senior Full-Stack & AI Engineer · [Portfolio](https://www.horacioparisotto.com/) · [LinkedIn](https://www.linkedin.com/in/horacioparisotto/)
