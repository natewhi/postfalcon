---
title: "Why Did My Scheduled Post Fail?"
slug: why-did-my-scheduled-post-fail
description: "The real reasons a scheduled post ends up Failed instead of Posted — missing media, an incomplete account connection, an expired token, or the platform's own API rejecting it — and how to fix each one."
date: 2026-09-22
tags: ["Guides", "Troubleshooting"]
draft: true
---

A post landing in **Failed** instead of **Posted** almost always comes down to one of four
things: the post itself was missing something a platform requires, the connected account isn't
fully set up, the account's access token expired, or the platform's own API rejected the
request. Here's how to tell which one you're looking at, and what to do about each.

## Missing media the platform requires

A few platforms won't accept a post that's missing (or has the wrong kind of) attachment:

- **Instagram** — every post needs an image or video attached. There's no text-only post.
- **Pinterest** — every Pin needs an image. Video Pins aren't supported yet.
- **TikTok** — every post needs a video attached.
- **Bluesky** — supports images, not video, so a video attached to a Bluesky post fails.

If a cross-posted post went to several channels and only one of them failed, this is the first
thing to check — the content that's fine for five platforms can still be missing something one
of them specifically requires.

## The account isn't fully connected

A handful of platforms need more than just an access token to publish — some extra piece of
setup that happens at connect time:

- **Mastodon** needs its instance domain on file.
- **Pinterest** needs a board on file (picked automatically when you connect).
- **Telegram** needs the bot to actually be an admin of the target channel/chat.

If one of these is missing — usually because the connection happened before that piece was
set up, or something changed on the platform's side since — the fix is the same: disconnect
and reconnect the account from the **Accounts** page.

## The account's token expired

Platforms renew most access tokens in the background, but that renewal can still fail:

- **Threads** self-refreshes its long-lived token automatically most of the time, but can still
  fail if that refresh itself lapses.
- **YouTube and TikTok** refresh their short-lived tokens automatically in the background on
  every publish attempt — you'll only see a failure here if the refresh token itself was
  revoked (e.g. you removed Postfalcon's access from your Google or TikTok account settings
  directly), in which case reconnecting is the fix.

Either way, the fix for an expired token is always the same: go to **Accounts** and reconnect
that channel. Posts you already had scheduled don't need to be rebuilt — once the account is
reconnected, [retry the failed post](#retrying-a-failed-post) and it'll go out from there.

## The platform's API rejected it

The remaining case is the platform itself saying no — a rate limit, a content policy match, a
temporary outage on their end, or an account-level restriction Postfalcon has no visibility into.
These show up as an HTTP error from that platform's own API, and the fix depends entirely on
what the platform is actually objecting to.

## Seeing the actual reason

Right now, the specific reason a post failed is stored (`error_message` on the post) but isn't
yet surfaced in the dashboard itself — the calendar just shows the **Failed** status. Until that
lands in the UI, the exact error text is visible through the [REST API](/api-docs) or an MCP
client's `list_posts` call, which is worth checking before assuming it's one of the common cases
above.

## Retrying a failed post

Once whatever caused it is fixed — media swapped, account reconnected, or you're confident it
was a transient API error — a failed post on the calendar has a retry button right on it. Retry
puts it back in the queue for the very next scheduling run, no need to recreate the post from
scratch.
