---
title: "Connect Any AI Agent to Postfox"
slug: connect-any-ai-agent
description: "Postfox's MCP server now works two ways: a local command for Claude Desktop and Cursor, or a remote URL for ChatGPT, Claude.ai, and anything else that speaks MCP. Same tools, same token, either way."
date: 2026-09-15
author: nathan
tags: ["Features", "AI Agents"]
image: /images/blog/connect-any-ai-agent.svg
heroImage: /images/blog/connect-any-ai-agent-hero-bg.svg
heroGradient: ["#6d28d9", "#818cf8"]
---

Postfox has had an [MCP server](/api-docs) for a while, but it only worked one way: your
agent's client had to be able to spawn a local process and pass it environment variables. That
covers Claude Desktop and Cursor's `command`-style config, but not agents that connect over a
URL instead — ChatGPT, Claude.ai, and a growing list of others. Postfox's MCP server now works
both ways.

## Two ways in, same tools

Both connect with the same personal API token from **Settings → API access for agents**, and
both expose the same six tools: `list_accounts`, `list_posts`, `create_post`, `update_post`,
`delete_post`, and `get_analytics_summary`.

**A local command** — for a client that spawns a process itself, like Claude Desktop or
Cursor's `command`-style MCP config:

```
node mcp/server.js
```

with `POSTFOX_BASE_URL` and `POSTFOX_API_TOKEN` set in its environment.

**A remote URL** — for a client that connects to a hosted endpoint instead, like ChatGPT,
Claude.ai, Cursor's `url`-style config, OpenClaw, or anything else that speaks
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):

```
https://your-postfox-host/mcp
```

with your token sent the normal way, as `Authorization: Bearer pf_<your token>`. No process to
run, no environment to manage — just a URL and a header.

## Nothing to migrate

If you're already using the local `mcp/server.js` script, nothing changes for you — it still
works exactly the same way, and both paths call the exact same tool implementations
underneath, so behavior can't drift between them. The remote endpoint is purely additive, for
the agents that need it.

## Not using MCP at all?

The [REST API](/api-docs) underneath both of them is the actual source of truth — a Custom GPT
Action, a shell script, or any other tool that can make an HTTPS request with a bearer token
can talk to Postfox directly without going through MCP at either endpoint.
