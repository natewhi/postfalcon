---
title: "Cross-Posting: Publish to Every Platform From One Composer"
slug: cross-posting-to-multiple-platforms
description: "How to write a post once in Postfox and publish it to multiple connected accounts at the same time, including how media attachments are handled."
date: 2026-09-08
author: nathan
tags: ["Features", "Guides"]
image: /images/blog/cross-posting-to-multiple-platforms.svg
heroImage: /images/blog/cross-posting-to-multiple-platforms-hero-bg.svg
heroGradient: ["#16a34a", "#4ade80"]
---

Writing the same announcement six different times for six different platforms is the exact
busywork Postfox exists to remove. Cross-posting lets you compose once and publish to every
channel you pick, in a single action.

## How to cross-post

Open the composer and look at the account picker at the top. It isn't a single-choice list —
click as many connected channels as you want to post to. Selecting more than one channel is
all it takes; there's no separate "cross-post" toggle to find.

Write your content once, attach media if you want it, and schedule or save as a draft as
usual. When the post goes out, Postfox publishes an independent copy to every channel you
selected, on the same schedule.

## What happens behind the scenes

Each channel gets its own post row, so they can succeed or fail independently — if one
platform rejects the post (an expired token, a content policy issue) the others still go out
normally, and the failure shows up filtered to just that one channel. All of the posts from
one cross-post are linked by a shared group ID so you can tell at a glance that they came
from the same composer session.

If you attach media, Postfox copies the files separately for each channel rather than
pointing every post at the same file. That matters because of how media cleanup works: old
files get removed once every post referencing them is in a terminal state (posted, failed, or
canceled), and separate copies mean deleting or editing one cross-posted entry can never
accidentally break the media on another.

## Using the API

If you're posting programmatically — from a script, a CI job, or an AI agent through the
[MCP server](/api-docs) — cross-posting works the same way at the API level:

```
POST /api/v1/posts
{
  "social_account_ids": [12, 15, 19],
  "content": "Shipping something new today.",
  "scheduled_for": "2026-09-20T15:00:00Z"
}
```

Pass an array of account IDs instead of a single `social_account_id`, and the response comes
back as `{ "crosspost_group_id": "...", "posts": [...] }` — one object per channel. A
single-channel request is unaffected and still returns a bare post object, so existing
integrations don't need to change.

## A note on plan limits

Cross-posting is included on every Postfox plan — it isn't gated behind a higher tier. What
does vary by plan is how many channels you can have connected at once; see the
[pricing page](/pricing) for the current limits on each plan.
