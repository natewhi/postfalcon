---
title: "Give Your AI Agent Access to Your Post Analytics"
slug: ai-agents-and-your-post-analytics
description: "Postfalcon's MCP server now has a 6th tool, get_analytics_summary, so Claude or any MCP-compatible agent can read your real engagement numbers, not just create and schedule posts."
date: 2026-09-15
author: nathan
tags: ["Features", "AI Agents"]
image: /images/blog/ai-agents-and-your-post-analytics.svg
heroImage: /images/blog/ai-agents-and-your-post-analytics-hero-bg.svg
heroGradient: ["#7c3aed", "#a78bfa"]
---

Postfalcon has shipped with a bundled [MCP server](/api-docs) for a while now, so an agent like
Claude could already draft, schedule, and manage your posts. With
[Analytics](/blog/post-analytics-see-whats-working) now live, it can read your results too.

## The new tool: `get_analytics_summary`

The MCP server now exposes six tools:

- `list_accounts` — your connected social accounts
- `list_posts` — filter by status or account
- `create_post` — draft or schedule a text post to one account
- `update_post` — change content, status, or schedule
- `delete_post` — remove a post
- `get_analytics_summary` — **new** — the same totals, 7-day chart, and top post the
  Analytics page shows

No setup beyond what you already have: if your agent is already connected via
`POSTFALCON_BASE_URL`/`POSTFALCON_API_TOKEN`, the new tool just shows up the next time it lists
available tools.

## What this actually enables

Concretely, you can now ask something like *"how did this week's posts do, and what should I
post more of?"* and the agent can pull real numbers to answer — not a guess, the same
view/like/comment counts pulled from each platform's own API that back the Analytics page. It
can just as easily follow that up by drafting a new post with `create_post`, using what it just
learned.

That loop — read what worked, create the next post, schedule it — is the whole point of
building this on the same REST API the web app uses rather than a bolt-on integration.
`create_post` still saves as a draft or a schedule, never publishes immediately, so nothing
goes out without landing on your calendar first where you can review it.

## Coverage note

`get_analytics_summary` returns exactly what the Analytics page shows, including its honesty
about gaps: Telegram and TikTok posts won't have metrics yet, and most platforms other than
YouTube and Threads don't report view counts. Your agent sees the same `null` fields you'd see
in the dashboard, not a made-up number.

Read the full tool list and REST endpoints at the [API docs](/api-docs).
