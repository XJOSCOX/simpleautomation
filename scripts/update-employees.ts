// scripts/update-employees.ts
/**
 * Usage:
 *   pnpm run dev:seed:dry   # preview
 *   pnpm run dev:seed       # execute
 *
 * Steps:
 * 1) Analyze (profile.json)
 * 2) Clean (trim/types/round)
 * 3) Validate (row rules)
 * 4) Upsert (Prisma)
 * 5) Weekly summary (PASS/WARN/FAIL to CSV)
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Row = {
  email?: string;
  employeeNum?: string;
  firstName?: string;
  lastName?: string;
  department?: string | null;
  role?: string | null;
  hoursWorked?: number | string | null;
  active?: boolean | string | null;
};

const prisma = new PrismaClient();
const OUT_DIR = path.resolve('out');
const INPUT = process.env.INPUT_FILE || 'data/employees.json';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);
const EXPECTED_WEEKLY_HOURS = Number(process.env.EXPECTED_WEEKLY_HOURS || 40);

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function toBool(v: unknown): boolean | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return undefined;
}

function toFloat2(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n * 100) / 100; // 2 decimals
  return undefined;
}

function profile(data: Row[]) {
  const cols = new Set<string>();
  data.forEach((r) => Object.keys(r).forEach((k) => cols.add(k)));
  return {
    rows: data.length,
    cols: [...cols],
    sample: data.slice(0, 5)
  };
}

function clean(r: Row) {
  const email = r.email?.toString().trim().toLowerCase();
  const employeeNum = r.employeeNum?.toString().trim();
  const firstName = r.firstName?.toString().trim();
  const lastName = r.lastName?.toString().trim();
  const department = r.department?.toString().trim() || null;
  const role = (r.role?.toString().trim() || 'Staff');
  const hoursWorked = toFloat2(r.hoursWorked) ?? 0;
  const active = toBool(r.active) ?? true;

  return { email, employeeNum, firstName, lastName, department, role, hoursWorked, active };
}

function validate(c: ReturnType<typeof clean>): string[] {
  const errs: string[] = [];
  if (!c.email && !c.employeeNum) errs.push('Missing unique key (email or employeeNum).');
  if (!c.firstName) errs.push('Missing firstName.');
  if (!c.lastName) errs.push('Missing lastName.');
  if (c.hoursWorked < 0) errs.push('hoursWorked cannot be negative.');
  if (c.hoursWorked > 24) errs.push('hoursWorked per record > 24 is not allowed.');
  return errs;
}

function toBatches<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Simple weekly check: we only have weekly totals per employee in this demo.
// In real world, you'd aggregate daily rows into week buckets.
function weeklySummary(rows: ReturnType<typeof clean>[]) {
  const map = new Map<string, number>(); // email/employeeNum -> totalHours
  for (const r of rows) {
    const key = r.email || r.employeeNum!;
    map.set(key, (map.get(key) ?? 0) + (r.hoursWorked ?? 0));
  }

  const entries = [...map.entries()].map(([key, total]) => {
    let status = 'PASS';
    if (total === 0) status = 'FAIL';
    else if (total > 0 && total < EXPECTED_WEEKLY_HOURS) status = 'WARN';
    // (over 40 treated as PASS here; change per policy)
    return {
      key,
      total_hours: Math.round(total * 100) / 100,
      expected_hours: EXPECTED_WEEKLY_HOURS,
      delta: Math.round((total - EXPECTED_WEEKLY_HOURS) * 100) / 100,
      status
    };
  });

  const csv = ['employeeKey,total_hours,expected_hours,delta,status']
    .concat(entries.map(e => `${e.key},${e.total_hours},${e.expected_hours},${e.delta},${e.status}`))
    .join('\n');

  const out = path.join(OUT_DIR, `weekly-summary-${Date.now()}.csv`);
  fs.writeFileSync(out, csv, 'utf-8');
  return { out, entries };
}

async function main() {
  ensureDir(OUT_DIR);

  if (!fs.existsSync(INPUT)) {
    console.error(`Input not found: ${INPUT}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(INPUT, 'utf-8');
  let rows: unknown;
  try { rows = JSON.parse(raw); } catch { console.error('Invalid JSON'); process.exit(1); }
  if (!Array.isArray(rows)) { console.error('JSON must be an array'); process.exit(1); }

  // 1) Analyze
  const prof = profile(rows as Row[]);
  fs.writeFileSync(path.join(OUT_DIR, 'profile.json'), JSON.stringify(prof, null, 2));

  // 2) Clean + 3) Validate
  const cleaned: ReturnType<typeof clean>[] = [];
  const errors: { index: number; error: string }[] = [];

  (rows as Row[]).forEach((r, i) => {
    const c = clean(r);
    const errs = validate(c);
    if (errs.length) errors.push({ index: i, error: errs.join('; ') });
    else cleaned.push(c);
  });

  console.log(`Loaded ${prof.rows} rows → valid: ${cleaned.length}, rejected: ${errors.length}`);
  if (errors.length) {
    fs.writeFileSync(path.join(OUT_DIR, `rejections-${Date.now()}.json`), JSON.stringify(errors, null, 2));
  }

  // 4) Upsert in batches (idempotent by unique key)
  const dry = process.argv.includes('--dry-run');
  let success = 0;

  if (!dry && cleaned.length) {
    const batches = toBatches(cleaned, BATCH_SIZE);
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      await prisma.$transaction(batch.map((c) => {
        if (c.email) {
          return prisma.employee.upsert({
            where: { email: c.email },
            update: {
              firstName: c.firstName!,
              lastName: c.lastName!,
              department: c.department,
              role: c.role,
              hoursWorked: c.hoursWorked!,
              active: c.active!,
              employeeNum: c.employeeNum ?? undefined,
            },
            create: {
              email: c.email,
              employeeNum: c.employeeNum ?? null,
              firstName: c.firstName!,
              lastName: c.lastName!,
              department: c.department,
              role: c.role,
              hoursWorked: c.hoursWorked!,
              active: c.active!,
            }
          });
        } else {
          // fallback to employeeNum path
          return prisma.employee.upsert({
            where: { employeeNum: c.employeeNum! },
            update: {
              firstName: c.firstName!,
              lastName: c.lastName!,
              department: c.department,
              role: c.role,
              hoursWorked: c.hoursWorked!,
              active: c.active!,
              email: c.email ?? undefined,
            },
            create: {
              employeeNum: c.employeeNum!,
              email: c.email ?? `${c.employeeNum!}@placeholder.local`,
              firstName: c.firstName!,
              lastName: c.lastName!,
              department: c.department,
              role: c.role,
              hoursWorked: c.hoursWorked!,
              active: c.active!,
            }
          });
        }
      }), { timeout: 60_000 });

      success += batch.length;
      console.log(`Batch ${b + 1}/${batches.length} upserted (${batch.length})`);
    }
  }

  // 5) Weekly summary
  const { out: weeklyCsv, entries } = weeklySummary(cleaned);
  const pass = entries.filter(e => e.status === 'PASS').length;
  const warn = entries.filter(e => e.status === 'WARN').length;
  const fail = entries.filter(e => e.status === 'FAIL').length;

  console.log(`DONE. Upserted: ${success} | Rejected: ${errors.length}`);
  console.log(`Weekly summary → ${weeklyCsv} | PASS=${pass} WARN=${warn} FAIL=${fail}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
