---
title: "How to Schedule Your First Post in Postfalcon"
slug: how-to-schedule-a-post
description: "How the Postfalcon composer works: writing a post, attaching media, saving drafts, and scheduling for later on the calendar."
date: 2026-08-27
author: nathan
tags: ["Getting Started", "Guides"]
image: /images/blog/how-to-schedule-a-post.svg
heroImage: /images/blog/how-to-schedule-a-post-hero-bg.svg
heroGradient: ["#6d5ef7", "#5b8def"]
---

Once you've [connected an account](/blog/connect-your-first-social-account), scheduling a
post takes under a minute. Here's what each part of the composer does.

## Opening the composer

From the [dashboard](/dashboard), click **+ New post**, or click directly on a day or time
slot in the calendar to open the composer pre-filled with that date. Either way, you land on
the same screen.

## Choosing where it goes

At the top of the composer is the account picker. Click a channel to select it — click
another one too, and Postfalcon will post the same content to both at once (more on that in our
[cross-posting guide](/blog/cross-posting-to-multiple-platforms)). The character counter
below the text box updates to match whichever platform you've selected, so you know before
you post whether you're over a limit.

## Writing the post

Type your content into the main text box. If you're posting to a video-only platform like
YouTube or TikTok, attach a video before scheduling — Postfalcon will tell you if one's missing
when you try to save.

To attach media, click **Add photo or video**. You can attach up to ten files per post; drag
to reorder them, and add alt text to each one individually for accessibility (and because
several platforms surface alt text in their own accessibility tooling).

## Draft or scheduled?

Under **When**, choose:

- **Save as draft** — the post is saved but never published automatically. Come back and
  edit or schedule it whenever you're ready.
- **Schedule** — pick a date and time, and Postfalcon's scheduler will publish it automatically
  once that time arrives, even if you're not logged in or your computer is off.

Scheduled posts also support **repeating** — daily, weekly, or monthly — with an optional end
date, which we cover in [setting up recurring posts](/blog/recurring-social-media-posts).

## Editing and rescheduling

Every post — draft or scheduled — shows up on the calendar and in the Drafts list. Drag a
scheduled post to a new day to reschedule it, or click it to open the editor, change the
content, or delete it outright. Once a post has actually gone out, its content becomes
read-only (you can't edit history), but it stays visible on the calendar marked **Posted**
so you can see exactly when it went out. If you're scripting against the
[REST API](/api-docs) instead, each published post also carries the platform's own post ID
for cross-referencing.

## What happens if publishing fails

If a platform rejects a post — an expired token, a content policy violation, a network hiccup
— Postfalcon marks it **Failed** rather than silently dropping it, and a banner appears on your
dashboard telling you how many posts need attention. Filter the calendar to **Failed** to see
exactly which ones and why, fix the underlying issue, and reschedule.
