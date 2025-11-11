# Weekly DB Updater (Prisma + TypeScript)

**Purpose**: Demonstrate a safe, idempotent weekly update pipeline:
- Analyze → Clean → Validate → **Upsert** to SQL Server with Prisma
- Weekly summary report (PASS/WARN/FAIL against 40h target)
- Scheduled run **every Friday 20:00 (8pm) America/Chicago** via Windows Task Scheduler + Git Bash

## Stack
- Node + TypeScript + Prisma
- SQL Server (change to Postgres by editing `schema.prisma` + `DATABASE_URL`)
- Git Bash or any Bash-compatible shell

## Setup
```bash
pnpm i   # or npm i / yarn
cp .env.example .env   # edit DATABASE_URL
pnpm run prisma:generate
pnpm run prisma:migrate
