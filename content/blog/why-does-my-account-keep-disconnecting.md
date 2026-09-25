---
title: "Why Does My Account Keep Disconnecting? How to Reconnect"
slug: why-does-my-account-keep-disconnecting
description: "Why a connected social account eventually needs to be reconnected — LinkedIn's 60-day token expiry, Threads' self-refresh, and when YouTube/TikTok's automatic refresh still fails — and the actual fix, which is always the same."
date: 2026-09-22
tags: ["Guides", "Troubleshooting"]
draft: true
---

Every social platform hands Postfalcon an access token when you connect an account, and every one
of those tokens is good for a while, not forever. Which platform you're on determines whether
that expiry happens silently in the background or eventually needs you to reconnect by hand.

## The platforms that refresh themselves

**YouTube and TikTok** issue a short-lived access token alongside a longer-lived refresh token.
Postfalcon uses that refresh token to get a new access token automatically on every publish
attempt — you should never notice this happening. The one case where it surfaces as a failure
is if the refresh token itself stops working, which almost always means access was revoked from
the platform's side (for example, removing Postfalcon from the list of connected apps in your
Google or TikTok account settings, not anything that happened in Postfalcon). If that happens,
reconnecting the account issues a fresh token pair and clears it.

**Threads** works similarly but without a separate refresh token — it self-refreshes its own
long-lived token on a schedule. This is more resilient than a token with a hard expiry, but it's
not unconditional: if that refresh lapses for long enough, the account needs a manual reconnect
the same as any other.

## The platform that just expires

**LinkedIn** is the odd one out: for standard apps, LinkedIn doesn't issue a refresh token at
all. The access token is good for about 60 days, and when it runs out, it runs out — there's no
silent renewal happening anywhere. A LinkedIn account that's been connected for a couple of
months eventually needing a reconnect isn't a bug or a sign something's wrong with your account;
it's just how LinkedIn's standard API access works. The failed post that results is a normal
error, not a red flag.

## Reconnecting an account

Whichever platform it is, the fix is identical: open **Accounts**, find the channel, and go
through the connect flow again. It picks up a fresh token immediately — you don't need to delete
the old connection first, and any posts that were scheduled against that account don't need to
be rebuilt. If a post already failed because of an expired token, [retry it](/blog/why-did-my-scheduled-post-fail#retrying-a-failed-post)
once the account is reconnected and it'll go out from there.

## Why this isn't a Postfalcon-specific quirk

This is true of every third-party scheduler, not something particular to how Postfalcon is built —
it's a direct consequence of how each platform's own OAuth implementation works. A tool that
claims a connection "never expires" is either only supporting platforms that happen to
self-refresh, or it's quietly failing the same way and just not telling you why.
