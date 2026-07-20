import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = process.env.POSTFOX_BASE_URL;
const API_TOKEN = process.env.POSTFOX_API_TOKEN;

if (!BASE_URL || !API_TOKEN) {
  console.error('POSTFOX_BASE_URL and POSTFOX_API_TOKEN environment variables are required.');
  process.exit(1);
}

async function apiRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
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

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const server = new McpServer({ name: 'postfox', version: '1.0.0' });

server.tool(
  'list_accounts',
  'List the connected social media accounts available to post to',
  {},
  async () => textResult(await apiRequest('/api/social-accounts'))
);

const STATUSES = ['draft', 'scheduled', 'posting', 'posted', 'failed', 'canceled'];

server.tool(
  'list_posts',
  'List posts, optionally filtered by status or connected account',
  {
    status: z.enum(STATUSES).optional().describe('Only return posts in this status'),
    social_account_id: z.number().optional().describe('Only return posts for this connected account'),
  },
  async ({ status, social_account_id }) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (social_account_id) params.set('social_account_id', String(social_account_id));
    const query = params.toString() ? `?${params.toString()}` : '';
    return textResult(await apiRequest(`/api/posts${query}`));
  }
);

server.tool(
  'create_post',
  'Create a new text post, either saved as a draft or scheduled for a specific time. Does not support attaching media — use the Postfox web app for image/video posts.',
  {
    social_account_id: z.number().describe('The connected account to post to (use list_accounts to find one)'),
    content: z.string().min(1).describe('The text content of the post'),
    scheduled_for: z
      .string()
      .datetime()
      .optional()
      .describe('ISO 8601 UTC datetime to schedule the post for; omit to save as a draft instead'),
  },
  async ({ social_account_id, content, scheduled_for }) =>
    textResult(
      await apiRequest('/api/posts', {
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
    post_id: z.number().describe('The ID of the post to update'),
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
      await apiRequest(`/api/posts/${post_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
    )
);

server.tool(
  'delete_post',
  'Permanently delete a post',
  { post_id: z.number().describe('The ID of the post to delete') },
  async ({ post_id }) => {
    await apiRequest(`/api/posts/${post_id}`, { method: 'DELETE' });
    return textResult(`Post ${post_id} deleted.`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
