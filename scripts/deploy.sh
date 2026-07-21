#!/usr/bin/env bash
# Run on the VPS, from the repo root, to deploy the latest main.
set -euo pipefail

git pull origin main
npm install --omit=dev
npm run migrate

if pm2 describe postfox > /dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --env production
else
  pm2 start ecosystem.config.cjs --env production
fi

pm2 save
