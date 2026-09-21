---
title: "Why We Built Postfox to Be Self-Hostable"
slug: why-self-host-your-social-media-scheduler
description: "The case for running your own social media scheduler instead of trusting a third party with your access tokens: data ownership, no vendor lock-in, and a real API."
date: 2026-09-14
author: nathan
tags: ["Product", "Open Source"]
image: /images/blog/why-self-host-your-social-media-scheduler.svg
heroImage: /images/blog/why-self-host-your-social-media-scheduler-hero-bg.svg
heroGradient: ["#1e293b", "#475569"]
---

Every social media scheduler asks for the same thing: access tokens for every account you
connect. That's an enormous amount of trust to hand a company you can't inspect. Postfox is
built differently — it's open source, and you can run it yourself.

## Your tokens stay in your database

When you connect an account to a hosted scheduling tool, your access tokens live on their
servers, protected by their security practices, subject to their breach-notification
timeline if something goes wrong. With a self-hosted Postfox, those tokens live in your own
Postgres database, on infrastructure you control. No third party sits between you and your
social accounts.

## No feature paywalled behind "contact sales"

Because Postfox is open source, the entire codebase — the scheduler, every platform adapter,
the billing logic itself — is visible and auditable rather than a black box you have to trust
on faith. If you're running your own instance, there's no vendor deciding which features are
worth gatekeeping behind an enterprise tier.

## Built for automation, not just humans

Postfox ships with a full [REST API](/api-docs) and an MCP server, so AI agents and scripts
can create, schedule, and manage posts the same way a person clicking around the dashboard
can. If you're building a workflow on top of your scheduler — auto-drafting posts from a CMS,
letting an AI agent handle your content calendar — that's a first-class use case, not an
afterthought bolted onto a UI-first product.

## Real platforms, not just the easy ones

We deliberately left [X/Twitter](https://developer.twitter.com) off the platform list: its
API is paid, and passing that cost on to users didn't sit right with an open source tool.
Instead, Postfox covers the platforms people actually post to for free — Mastodon, Bluesky,
Facebook, Instagram, Threads, Telegram, YouTube, and TikTok — with more on the way.

## Don't want to run your own server?

Self-hosting isn't mandatory — Postfox is also available as a hosted service with a 7-day
free trial on every plan, if you'd rather not manage a server yourself. Either way, the
software underneath is the same: nothing about the hosted version is a different, more
limited product.

Ready to see it in action? [Compare plans](/pricing) or read how to
[connect your first account](/blog/connect-your-first-social-account).
