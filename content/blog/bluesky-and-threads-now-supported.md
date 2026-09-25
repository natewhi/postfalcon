---
title: "Bluesky and Threads Are Now Live"
slug: bluesky-and-threads-now-supported
description: "Postfalcon now schedules posts to Bluesky and Threads, bringing the total to 8 supported platforms. Here's how each connects and what's supported at launch."
date: 2026-09-15
author: nathan
tags: ["Features", "Platforms"]
image: /images/blog/bluesky-and-threads-now-supported.svg
heroImage: /images/blog/bluesky-and-threads-now-supported-hero-bg.svg
heroGradient: ["#2563eb", "#1185FE"]
---

Postfalcon now schedules and cross-posts to **Bluesky** and **Threads**, bringing the total to
8 live platforms: Mastodon, Bluesky, Facebook, Instagram, Threads, Telegram, YouTube, and
TikTok.

We picked these two first because they fit the platforms we already support — real, free
publishing APIs, no paid-API tier required, no chat-app workarounds.

## Connecting Bluesky

Bluesky doesn't have third-party OAuth yet, so connecting it works like Telegram: you give
Postfalcon a credential directly instead of going through a login redirect. In Bluesky's own
Settings, generate an **app password** (not your real account password — Bluesky explicitly
supports issuing separate, revocable app passwords for exactly this purpose), then paste your
handle and that app password into the connect form on the **Accounts** page.

At launch, Bluesky posts support text plus up to 4 images. Video isn't supported yet — attach
one and Postfalcon will tell you clearly instead of silently dropping it.

## Connecting Threads

Threads connects the normal way: click **Connect** on the Accounts page and go through
Threads' own OAuth login, using a separate app registration from Facebook/Instagram (so
disconnecting one doesn't affect the other). Once connected, Threads posts support text,
images, video, and carousels — full parity with what Instagram supports today, since Threads'
publishing API is deliberately shaped like Instagram's.

Threads access tokens are long-lived (about 60 days) rather than short-lived-with-a-refresh-
token like YouTube or TikTok. Postfalcon refreshes it automatically in the background a week
before it would expire, so a connected Threads account shouldn't ever need reconnecting on
its own.

## Both work everywhere else, too

Cross-posting, recurring posts, the calendar, and [Analytics](/blog/post-analytics-see-whats-working)
all treat Bluesky and Threads exactly like every other platform — there's nothing extra to set
up. Analytics coverage differs slightly per platform: Threads reports views, likes, and
comments; Bluesky reports likes and comments (no view counts, since that's not something the
Bluesky API exposes).

Head to [Accounts](/accounts) to connect either one.
