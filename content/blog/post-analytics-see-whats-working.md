---
title: "Post Analytics: See What's Actually Working"
slug: post-analytics-see-whats-working
description: "Postfox now pulls real view, like, comment, and share counts from each connected platform. Here's what the new Analytics page shows, where the numbers come from, and which platforms report what."
date: 2026-09-15
author: nathan
tags: ["Features", "Analytics"]
---

Scheduling a post and watching it go out on time is only half the story. The other half is
knowing whether it actually landed — and until now, Postfox couldn't tell you that. It could
tell you a post was **posted**, but not whether anyone saw it.

That's what the new **Analytics** page is for.

## What it shows

Open **Analytics** in the sidebar and you'll see four totals — views, likes, comments, and
shares — a bar chart of views over the last 7 days, and a callout for your top-performing post
that week. All of it is pulled from your own connected accounts; nothing is estimated or
extrapolated.

## Where the numbers come from

A background job checks in on your recently-published posts every three hours and asks each
platform's own API for its current view/like/comment/share counts, then stores the latest
snapshot on the post. It only looks at posts from the last 30 days, so older posts stop being
polled once they're unlikely to move much further.

That also means numbers aren't instant — give a freshly-published post a little while (up to a
few hours) before its first real numbers show up.

## Coverage varies by platform, on purpose

Not every platform's API exposes the same data through the permissions Postfox already
requests, and we'd rather be upfront about that than fake a number:

- **YouTube** and **Threads** report the most — views, likes, and comments.
- **Mastodon**, **Bluesky**, **Facebook**, and **Instagram** report likes and comments, but not
  view counts (that needs a separate insights permission we don't currently request).
- **Telegram** and **TikTok** don't expose post-level metrics through their APIs at all yet, so
  posts to those stay unmetered rather than showing a fake zero.

The Analytics page says exactly this too, right under the chart, so it's never a mystery why one
post shows a view count and another doesn't.

## It's not just for you

The same numbers are available to your MCP-connected agent as a tool call — see
[giving your AI agent access to your analytics](/blog/ai-agents-and-your-post-analytics) — and
over the REST API at `GET /api/v1/analytics/summary` for anyone scripting against Postfox
directly (see the [API docs](/api-docs)).

Every plan includes Analytics — it isn't gated behind a higher tier.
