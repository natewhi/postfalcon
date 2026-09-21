---
title: "How to Schedule Instagram Posts in Advance"
slug: how-to-schedule-instagram-posts-in-advance
description: "What you need before Instagram scheduling works at all (a Business or Creator account linked to a Facebook Page), what Postfox can auto-publish, and what still needs to happen manually."
date: 2026-09-18
tags: ["Guides", "Platforms"]
draft: true
---

Instagram doesn't let just anyone auto-publish to it. Before any scheduler — Postfox included —
can post on your behalf, there's a required setup step on Instagram's side first.

## What has to be true before scheduling works

- Your Instagram account has to be a **Business or Creator account**, not a personal one.
- It has to be **linked to a Facebook Page** you manage — Instagram's API for third-party
  publishing is routed through Meta's Graph API via that Page connection, not through Instagram
  directly.

If either of those isn't set up yet, do that first in Instagram's own account settings before
connecting anything to a scheduler.

## Connecting it in Postfox

Instagram doesn't get its own connect button — connecting a Facebook Page (see
[connecting your first account](/blog/connect-your-first-social-account)) picks up any Instagram
Business account linked to that Page automatically, since they share the same Facebook OAuth
flow under the hood.

## What can actually be scheduled

Feed posts — a single image, a single video, or a carousel of multiple images/videos — can be
composed, scheduled, and auto-published the same way as any other platform in Postfox. Stories
are a different, more ephemeral content type that Instagram's API doesn't expose the same way for
third-party auto-publishing, so they're not something a scheduled composer post covers.

## Why schedule instead of posting live

Once the account is connected, the actual scheduling part is identical to any other
platform — pick the date and time in the [composer](/blog/how-to-schedule-a-post), and it
publishes automatically when that time comes rather than needing someone to be online and posting
live. Pair it with [cross-posting](/blog/cross-posting-to-multiple-platforms) if the same image
or caption is also going out to other channels, so it's written once instead of per platform.
