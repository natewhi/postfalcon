---
title: "Set It and Forget It: Recurring Posts in Postfox"
slug: recurring-social-media-posts
description: "How to set up daily, weekly, or monthly recurring posts in Postfox, how the end date works, and what happens to attached media each time a post repeats."
date: 2026-09-11
author: nathan
tags: ["Features", "Guides"]
image: /images/blog/recurring-social-media-posts.svg
heroImage: /images/blog/recurring-social-media-posts-hero-bg.svg
heroGradient: ["#f59e0b", "#fbbf24"]
---

Some posts don't happen once — a weekly roundup, a daily reminder, a monthly "we're hiring"
nudge. Instead of re-creating the same post on a recurring basis, Postfox can do it for you.

## Setting up a repeating post

Open the composer and switch **When** to **Schedule**. Once you've picked a date and time, a
**Repeat** option appears underneath it with four choices:

- **Don't repeat** — the default; a normal one-off scheduled post.
- **Every day**
- **Every week**
- **Every month**

Pick one, and an optional **Until** date shows up. Leave it blank and the series keeps going
(Postfox caps any recurring series at one year out as a safety net); set it and the series
stops cleanly after that date.

## What happens when a repeating post publishes

The moment a repeating post goes out, Postfox immediately schedules its next occurrence —
same content, same channel, same repeat settings — at the next interval. You'll see the new
occurrence appear on your calendar right away rather than waiting for some background job to
catch up later.

If the original post had media attached, each new occurrence gets its own copy of those
files rather than sharing the original. That's deliberate: it means editing or deleting one
occurrence in the series can never affect another, and the media cleanup job (which removes
old uploads once a post is fully resolved) can't orphan a file a future occurrence still
needs.

## Editing a series

A recurring post's occurrences aren't locked together — each one is a normal post you can
open, edit, or delete independently from the calendar. Changing the content on one upcoming
occurrence doesn't rewrite the others; if you want to change the series going forward,
you'll want to edit each future occurrence you care about (or turn off repeating on the
current one and start a fresh series with the new content).

To stop a series early, open any upcoming occurrence and switch **Repeat** back to **Don't
repeat**, or delete the individual occurrences you don't want.

## Combine it with cross-posting

Recurring posts and [cross-posting](/blog/cross-posting-to-multiple-platforms) work together
— select multiple channels and a repeat interval on the same post, and every channel gets its
own independent recurring series. A weekly update to three platforms is still just one
composer session.
