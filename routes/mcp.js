import { Router } from 'express';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../lib/mcpServer.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

// Open like /api/v1's CORS — a remote MCP client authenticates with a Bearer token, which a
// cross-origin browser request can't forge (no cookie/session involved), so there's nothing
// same-origin restriction would protect here.
router.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'] }));

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'not authenticated' });
    }
    const token = auth.slice(7).trim();

    // A fresh server + transport per request rather than one shared connection — this is
    // "stateless mode" per the MCP spec, the one every Streamable HTTP client is guaranteed to
    // support (no session id to track across calls, so nothing to lose if a client's requests
    // land on different app instances — moot today at instances:1, but free to get right).
    //
    // baseUrl is derived from the request itself rather than process.env.BASE_URL: unlike every
    // other BASE_URL call site (OAuth redirect URIs, emailed links, stored media URLs), this one
    // never leaves the process — createMcpServer's tools just fetch() the app's own REST API
    // within this same request, so it needs to reach whatever host:port this request actually
    // arrived on (respects X-Forwarded-Proto/Host, since app.js sets `trust proxy`).
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const server = createMcpServer({ baseUrl, token });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  })
);

// Stateless mode has no session to resume (GET, for server-initiated notifications) or end
// (DELETE) — same "not supported" response a stateful server gives for an unrecognized session.
router.get('/', (req, res) => {
  res.status(405).json({ error: 'method_not_allowed', message: 'This endpoint is stateless — send POST JSON-RPC requests.' });
});

router.delete('/', (req, res) => {
  res.status(405).json({ error: 'method_not_allowed' });
});

export default router;
