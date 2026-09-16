import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../lib/mcpServer.js';

const baseUrl = process.env.POSTFOX_BASE_URL;
const token = process.env.POSTFOX_API_TOKEN;

if (!baseUrl || !token) {
  console.error('POSTFOX_BASE_URL and POSTFOX_API_TOKEN environment variables are required.');
  process.exit(1);
}

// Local, stdio-based MCP — for clients that spawn a command directly (Claude Desktop, Cursor's
// `command`-style config, etc). Every tool is defined once in lib/mcpServer.js and shared with
// routes/mcp.js's remote HTTP endpoint, which any MCP client using a URL instead (ChatGPT,
// Claude.ai, Cursor's `url`-style config, or any other Streamable HTTP client) connects to
// instead of running this script at all.
const server = createMcpServer({ baseUrl, token });
const transport = new StdioServerTransport();
await server.connect(transport);
