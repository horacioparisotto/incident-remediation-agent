import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/** The platform's public API, called with the triggering user's forwarded session token. */
export interface PlatformApi {
  incidents: { get(id: string): Promise<{ id: string; title: string; controlIds: string[]; involved: Array<{ email: string }> }> };
  controls: { get(id: string): Promise<{ id: string; title: string }> };
  users: { findByEmail(email: string): Promise<{ id: string; name: string; email: string } | null> };
  skills: { listPublished(): Promise<Array<{ id: string; title: string; summary: string }>> };
}

export type PlatformClient = (sessionToken: string) => PlatformApi;

/**
 * The agent reaches the platform the way an outside tool would: through four
 * narrow, named MCP tools, with no database access and no credentials of its
 * own. Every call carries the forwarded session token of whoever triggered the
 * incident, so a tool can only do what its caller could do by hand.
 *
 * Deliberately not one tool per API endpoint: a tool can orchestrate several
 * calls behind it, so the surface reflects what the agent needs to decide.
 */
export function createAgentServer(client: PlatformClient): McpServer {
  const server = new McpServer({ name: 'remediation-tools', version: '1.0.0' });

  server.registerTool(
    'get_incident',
    {
      description: 'Read an incident with the controls it touched.',
      inputSchema: { incidentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId }, extra) =>
      withSession(extra.authInfo?.token, async (api) => {
        const incident = await api.incidents.get(incidentId);
        const controls = await Promise.all(incident.controlIds.map((id) => api.controls.get(id)));
        return { id: incident.id, title: incident.title, controls };
      }),
  );

  server.registerTool(
    'resolve_people',
    {
      description: 'Map the people named in an incident to real accounts.',
      inputSchema: { incidentId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ incidentId }, extra) =>
      withSession(extra.authInfo?.token, async (api) => {
        const incident = await api.incidents.get(incidentId);
        const accounts = await Promise.all(incident.involved.map((p) => api.users.findByEmail(p.email)));
        return accounts.filter((a) => a !== null).map(({ id, name }) => ({ id, name }));
      }),
  );

  server.registerTool(
    'list_skills',
    {
      description: "List the tenant's published skills, to judge whether one already covers a gap.",
      annotations: { readOnlyHint: true },
    },
    async (extra) => withSession(extra.authInfo?.token, (api) => api.skills.listPublished()),
  );

  server.registerTool(
    'get_control',
    {
      description: 'Read one control in detail.',
      inputSchema: { controlId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ controlId }, extra) => withSession(extra.authInfo?.token, (api) => api.controls.get(controlId)),
  );

  async function withSession(token: string | undefined, fn: (api: PlatformApi) => Promise<unknown>): Promise<CallToolResult> {
    if (!token) {
      return { isError: true, content: [{ type: 'text', text: 'No session: tools only run as the triggering user.' }] };
    }
    const result = await fn(client(token));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  return server;
}
