#!/usr/bin/env bash
set -euo pipefail

# cd to repo root
cd "$(dirname "$0")/.."

mkdir -p out
echo "[$(date)] Weekly update start" >> out/schedule.log 2>&1

# Load env (if you keep a .env locally)
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs) || true
fi

# run (change to :dry until you're ready)
pnpm run dev:seed >> out/schedule.log 2>&1

echo "[$(date)] Weekly update done" >> out/schedule.log 2>&1
