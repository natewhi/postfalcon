import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const STATUSES = ['draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled'];

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

// Builds a fresh McpServer with all of Postfox's tools registered, each one just a thin call
// against Postfox's own public REST API (the same one documented at /api-docs) — that's the
// one place tool behavior actually lives, whether this server ends up reached over stdio
// (mcp/server.js — a local process, run by Claude Desktop/Cursor/any client that spawns a
// command, authenticated with a token from POSTFOX_API_TOKEN) or over the remote HTTP endpoint
// (routes/mcp.js — no local process needed, for ChatGPT/Claude.ai/any client that speaks
// Streamable HTTP, authenticated with the token straight off the caller's own Authorization
// header). Call sites differ only in where `token` comes from.
export function createMcpServer({ baseUrl, token }) {
  async function apiRequest(path, options = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Postfox API error (${res.status}): ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const server = new McpServer({ name: 'postfox', version: '1.0.0' });

  server.tool(
    'list_accounts',
    'List the connected social media accounts available to post to',
    {},
    async () => textResult(await apiRequest('/api/v1/social-accounts'))
  );

  server.tool(
    'get_analytics_summary',
    "Get engagement totals, a 7-day views chart, and the top-performing post this week, aggregated across connected accounts. Coverage varies by platform — Telegram and TikTok don't report post metrics.",
    {},
    async () => textResult(await apiRequest('/api/v1/analytics/summary'))
  );

  server.tool(
    'list_posts',
    'List posts, optionally filtered by status or connected account',
    {
      status: z.enum(STATUSES).optional().describe('Only return posts in this status'),
      social_account_id: z.coerce.number().optional().describe('Only return posts for this connected account'),
    },
    async ({ status, social_account_id }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (social_account_id) params.set('social_account_id', String(social_account_id));
      const query = params.toString() ? `?${params.toString()}` : '';
      return textResult(await apiRequest(`/api/v1/posts${query}`));
    }
  );

  server.tool(
    'create_post',
    'Create a new text post, either saved as a draft or scheduled for a specific time. Does not support attaching media — use the Postfox web app for image/video posts.',
    {
      social_account_id: z.coerce.number().describe('The connected account to post to (use list_accounts to find one)'),
      content: z.string().min(1).describe('The text content of the post'),
      scheduled_for: z
        .string()
        .datetime()
        .optional()
        .describe('ISO 8601 UTC datetime to schedule the post for; omit to save as a draft instead'),
    },
    async ({ social_account_id, content, scheduled_for }) =>
      textResult(
        await apiRequest('/api/v1/posts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ social_account_id, content, scheduled_for }),
        })
      )
  );

  server.tool(
    'update_post',
    "Update an existing draft or scheduled post's content, status, or schedule time",
    {
      post_id: z.coerce.number().describe('The ID of the post to update'),
      content: z.string().min(1).optional(),
      status: z.enum(STATUSES).optional(),
      scheduled_for: z
        .string()
        .datetime()
        .nullable()
        .optional()
        .describe('ISO 8601 UTC datetime, or null to unschedule and revert to a draft'),
    },
    async ({ post_id, ...updates }) =>
      textResult(
        await apiRequest(`/api/v1/posts/${post_id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        })
      )
  );

  server.tool(
    'delete_post',
    'Permanently delete a post',
    { post_id: z.coerce.number().describe('The ID of the post to delete') },
    async ({ post_id }) => {
      await apiRequest(`/api/v1/posts/${post_id}`, { method: 'DELETE' });
      return textResult(`Post ${post_id} deleted.`);
    }
  );

  return server;
}
