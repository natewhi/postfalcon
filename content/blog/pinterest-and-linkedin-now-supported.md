---
title: "Pinterest and LinkedIn Are Now Live"
slug: pinterest-and-linkedin-now-supported
description: "Postfalcon now schedules Pins to Pinterest and posts to your personal LinkedIn profile, bringing the total to 10 supported platforms. Here's how each connects and what's supported at launch."
date: 2026-09-16
author: nathan
tags: ["Features", "Platforms"]
image: /images/blog/pinterest-and-linkedin-now-supported.svg
heroImage: /images/blog/pinterest-and-linkedin-now-supported-hero-bg.svg
heroGradient: ["#e11d48", "#2563eb"]
---

Postfalcon now schedules posts to **Pinterest** and **LinkedIn**, bringing the total to 10 live
platforms: Mastodon, Bluesky, Facebook, Instagram, Threads, Telegram, YouTube, TikTok,
Pinterest, and LinkedIn.

Both connect the normal way &mdash; click **Connect** on the [Accounts](/accounts) page and
go through each platform's own OAuth login &mdash; using access levels that are open to any
registered app, not the partner-approval-gated tiers some of these platforms also have.

## Connecting Pinterest

A Pinterest Pin is always an image (there's no text-only Pin type), so every post to Pinterest
needs a photo attached. At connect time, Postfalcon picks your account's first board automatically
&mdash; there's no board-picker yet, so if you use multiple boards, all of your scheduled Pins
will land on that first one for now.

Postfalcon posts the image straight from its own upload URL, so there's no separate upload step;
the post's text becomes the Pin's description.

## Connecting LinkedIn

LinkedIn connects through **Sign In with LinkedIn** and posts through the **Share on LinkedIn**
product &mdash; both self-serve, unlike LinkedIn's Company Page and analytics APIs, which
require a Marketing Developer Platform partner review most self-hosters won't have. That means
LinkedIn support here is for your **personal profile**, not a Company Page.

At launch, LinkedIn posts are **text only** &mdash; image and video posting needs LinkedIn's
separate multi-step upload flow, which isn't built yet. Attach media to a LinkedIn post and it
fails clearly rather than silently dropping the image.

One more LinkedIn-specific note: its access tokens don't come with a refresh token for
standard apps, so a connected account will need reconnecting roughly every couple of months
when the token expires. Postfalcon will surface that as a clear failed-post error rather than a
silent skip.

## Both work everywhere else, too

Cross-posting, recurring posts, the calendar, and
[Analytics](/blog/post-analytics-see-whats-working) all treat Pinterest and LinkedIn like any
other platform. Analytics coverage is the one exception for now &mdash; neither has a metrics
adapter yet, so their posts stay unmetered on the Analytics page, the same honest gap Telegram
and TikTok already have.

Head to [Accounts](/accounts) to connect either one.
