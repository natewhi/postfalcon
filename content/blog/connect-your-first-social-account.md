---
title: "Getting Started: Connect Your First Social Account"
slug: connect-your-first-social-account
description: "A step-by-step walkthrough of connecting Mastodon, Bluesky, Facebook, Instagram, Threads, Telegram, YouTube, TikTok, Pinterest, and LinkedIn to Postfalcon, plus what to do if a connection fails."
date: 2026-08-20
author: nathan
tags: ["Getting Started", "Guides"]
image: /images/blog/connect-your-first-social-account.svg
heroImage: /images/blog/connect-your-first-social-account-hero-bg.svg
heroGradient: ["#0ea5e9", "#38bdf8"]
---

Before Postfalcon can publish anything on your behalf, it needs somewhere to publish it. That
means connecting at least one account from the **Accounts** page — and because every
platform authenticates differently, this guide walks through each one so you know exactly
what to expect.

## Where to connect accounts

Log in and open **Accounts** from the sidebar. Every platform Postfalcon supports live has its
own card with a "Connect" button or a small form. You can connect as many accounts as your
plan allows, across as many platforms as you like — there's no limit on mixing and matching.

## OAuth platforms: Mastodon, Facebook, Instagram, Threads, YouTube, TikTok, Pinterest, LinkedIn

Most platforms use OAuth: you click "Connect," get redirected to the platform's own login
screen, approve the permissions Postfalcon is asking for, and land back on your Accounts page
with the new account listed. Postfalcon never sees your password — only the access token the
platform hands back after you approve.

A couple of platform-specific notes:

- **Mastodon** asks for your instance domain first (e.g. `mastodon.social`), since Mastodon
  is federated and each instance runs its own OAuth app.
- **Instagram** rides on the Facebook connect flow — connect your Facebook Page first, and
  any Instagram business account linked to it comes along automatically.
- **YouTube** and **TikTok** are video-only platforms. You can connect them the same way as
  any other OAuth account, but Postfalcon will ask for a video file when you come to post.
- **Pinterest** picks your account's first board automatically — there's no board picker yet,
  so every scheduled Pin lands there for now. Pins always need an image attached.
- **LinkedIn** connects your personal profile (not a Company Page) and is text-only for now —
  image and video posting isn't built yet.

## Telegram: a bot token instead of a login

Telegram doesn't have a "sign in with Telegram" flow for third-party apps, so you'll create a
bot instead:

1. Message [@BotFather](https://t.me/botfather) on Telegram and run `/newbot`.
2. Copy the token it gives you.
3. Add the bot to your channel as an admin.
4. Paste the token and your channel handle (or numeric chat ID) into the Telegram card on
   the Accounts page.

Postfalcon verifies the token and confirms it can see your channel before saving anything.

## Bluesky: an app password, not your real one

Bluesky doesn't have third-party OAuth yet, so you'll generate an **app password** instead
of using your account password directly:

1. In Bluesky, go to **Settings → App Passwords** and create a new one.
2. Copy the generated password (it looks like `xxxx-xxxx-xxxx-xxxx`).
3. Enter your handle and that app password into the Bluesky card on the Accounts page.

Using an app password means you can revoke Postfalcon's access at any time from Bluesky's
settings without changing your main login.

## If a connection fails

A failed connection almost always comes down to one of three things:

- **Missing permissions** — you declined a scope Postfalcon needs during the OAuth prompt. Try
  connecting again and accept all requested permissions.
- **Channel/bot admin access** — for Telegram, double-check the bot is actually an admin of
  the channel, not just a member.
- **Plan limits** — each plan has a cap on connected channels. If you're at the limit,
  [upgrading your plan](/pricing) unlocks more without needing to disconnect anything.

Once an account shows up on your Accounts page, it's ready to use — head to the
[dashboard](/dashboard) to compose your first post.
