import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import app from '../app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_PATH = path.join(__dirname, '../mcp/server.js');

// mcp/server.js talks to POSTFALCON_BASE_URL over real HTTP, so it needs a real listening
// server — supertest's in-memory request(app) isn't reachable from the spawned subprocess.
let httpServer;
let baseUrl;

beforeAll(async () => {
  httpServer = app.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
}, 20000);

afterAll(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
});

async function createUserWithToken(email) {
  const agent = request.agent(app);
  await agent.post('/api/users').send({ email, password: 'password123' });
  await agent.post('/api/auth/login').send({ email, password: 'password123' });
  const tokenRes = await agent.post('/api/auth/api-token');
  return { agent, token: tokenRes.body.token };
}

// Spawns the actual mcp/server.js script as a subprocess talking over real stdio, exactly
// like a real MCP client (Claude Desktop, an agent, etc.) would run it — not an in-memory
// stub of it. A pass here means the shipped script genuinely works end to end.
async function connectMcpClient(token) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    env: { POSTFALCON_BASE_URL: baseUrl, POSTFALCON_API_TOKEN: token },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function toolJson(result) {
  return JSON.parse(result.content[0].text);
}

describe('mcp server', () => {
  it('exposes the expected tools', async () => {
    const { token } = await createUserWithToken('mcp-tools@example.com');
    const client = await connectMcpClient(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['create_post', 'delete_post', 'get_analytics_summary', 'list_accounts', 'list_posts', 'update_post'].sort()
      );
    } finally {
      await client.close();
    }
  }, 20000);

  it('surfaces a garbage bearer token as an MCP tool error', async () => {
    const badToken = await connectMcpClient('pf_not_a_real_token');
    try {
      const result = await badToken.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/401/);
    } finally {
      await badToken.close();
    }
  }, 20000);

  it('drives the full post lifecycle through real HTTP calls to the API', async () => {
    const { agent, token } = await createUserWithToken('mcp-lifecycle@example.com');
    const account = await agent.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@mcp' });

    const client = await connectMcpClient(token);
    try {
      // Account ids come back from the REST API as JSON strings (Postgres BIGINT columns
      // are serialized as strings by `pg` to avoid precision loss) — passing that string
      // straight through, exactly as an agent reading list_accounts output would, is the
      // regression test for the z.coerce.number() fix on social_account_id/post_id.
      const accountIdAsSeenByAgent = String(account.body.id);

      const accounts = toolJson(await client.callTool({ name: 'list_accounts', arguments: {} }));
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe(accountIdAsSeenByAgent);

      const created = await client.callTool({
        name: 'create_post',
        arguments: { social_account_id: accountIdAsSeenByAgent, content: 'hello from mcp' },
      });
      const post = toolJson(created);
      expect(post.content).toBe('hello from mcp');
      expect(post.status).toBe('draft');

      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const updated = toolJson(
        await client.callTool({
          name: 'update_post',
          arguments: { post_id: String(post.id), status: 'scheduled', scheduled_for: future },
        })
      );
      expect(updated.status).toBe('scheduled');

      const scheduledList = toolJson(
        await client.callTool({ name: 'list_posts', arguments: { status: 'scheduled' } })
      );
      expect(scheduledList).toHaveLength(1);
      expect(scheduledList[0].id).toBe(post.id);

      await client.callTool({ name: 'delete_post', arguments: { post_id: String(post.id) } });

      const afterDelete = toolJson(await client.callTool({ name: 'list_posts', arguments: {} }));
      expect(afterDelete).toHaveLength(0);
    } finally {
      await client.close();
    }
  }, 20000);

  it('get_analytics_summary wraps the real analytics endpoint', async () => {
    const { token } = await createUserWithToken('mcp-analytics@example.com');
    const client = await connectMcpClient(token);
    try {
      const summary = toolJson(await client.callTool({ name: 'get_analytics_summary', arguments: {} }));
      expect(summary.days).toHaveLength(7);
      expect(summary.totals).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
      expect(summary.topPost).toBeNull();
    } finally {
      await client.close();
    }
  }, 20000);

  it('surfaces an invalid social_account_id as an MCP tool error, not a crash', async () => {
    const { token } = await createUserWithToken('mcp-error@example.com');
    const client = await connectMcpClient(token);
    try {
      const result = await client.callTool({
        name: 'create_post',
        arguments: { social_account_id: 999999999, content: 'should fail' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Postfalcon API error \(400\)/);
    } finally {
      await client.close();
    }
  }, 20000);

  it("scopes posts to the calling user's own token", async () => {
    const userA = await createUserWithToken('mcp-tenant-a@example.com');
    const accountA = await userA.agent
      .post('/api/v1/social-accounts')
      .send({ platform: 'twitter', display_name: '@a' });
    const clientA = await connectMcpClient(userA.token);
    try {
      await clientA.callTool({
        name: 'create_post',
        arguments: { social_account_id: accountA.body.id, content: 'from user A' },
      });
    } finally {
      await clientA.close();
    }

    const userB = await createUserWithToken('mcp-tenant-b@example.com');
    const clientB = await connectMcpClient(userB.token);
    try {
      const postsForB = toolJson(await clientB.callTool({ name: 'list_posts', arguments: {} }));
      expect(postsForB).toHaveLength(0);

      const accountsForB = toolJson(await clientB.callTool({ name: 'list_accounts', arguments: {} }));
      expect(accountsForB).toHaveLength(0);
    } finally {
      await clientB.close();
    }
  }, 20000);
});

// The remote counterpart to the stdio tests above — same tools (lib/mcpServer.js is the one
// place their behavior lives), reached at a URL instead of a locally-spawned process. This is
// what a client that can't run a local command (ChatGPT, Claude.ai, or any other Streamable
// HTTP-speaking agent) connects to instead of mcp/server.js.
async function connectRemoteMcpClient(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test-http-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('remote MCP endpoint (Streamable HTTP)', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('drives the same tools over HTTP as the stdio server exposes', async () => {
    const { agent, token } = await createUserWithToken('mcp-http-lifecycle@example.com');
    const account = await agent.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@http' });

    const client = await connectRemoteMcpClient(token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['create_post', 'delete_post', 'get_analytics_summary', 'list_accounts', 'list_posts', 'update_post'].sort()
      );

      const created = await client.callTool({
        name: 'create_post',
        arguments: { social_account_id: String(account.body.id), content: 'hello from remote mcp' },
      });
      const post = toolJson(created);
      expect(post.content).toBe('hello from remote mcp');

      const analytics = toolJson(await client.callTool({ name: 'get_analytics_summary', arguments: {} }));
      expect(analytics.days).toHaveLength(7);

      await client.callTool({ name: 'delete_post', arguments: { post_id: String(post.id) } });
      const after = toolJson(await client.callTool({ name: 'list_posts', arguments: {} }));
      expect(after).toHaveLength(0);
    } finally {
      await client.close();
    }
  }, 20000);

  it('surfaces an invalid token as a tool error, same as the stdio server does', async () => {
    const client = await connectRemoteMcpClient('pf_not_a_real_token');
    try {
      const result = await client.callTool({ name: 'list_accounts', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/401/);
    } finally {
      await client.close();
    }
  }, 20000);
});
