import { Database } from 'bun:sqlite';
import { FAKE_HISTORY_MS, fakeTimeline, profile, type Profile, type UsageRow } from '../test/fake-keeper';

// Profiles a keeper DB and the fake over the same span through one profile(), to calibrate test/fake-keeper.ts.
// Usage: bun scripts/keeper-profile.ts [keeper db, default the live one] [days, default 28]
// The DB is opened read-only. Accounts print as ranks by request count, never as their ids.

const path = process.argv[2] ?? '/opt/homebrew/var/cpa-usage-keeper/app.db';
const days = Number(process.argv[3] ?? 28);
const db = new Database(`file:${path}?mode=ro`, { readonly: true });
db.exec('PRAGMA query_only = ON');

interface Row {
  id: number;
  jd: number;
  account: string;
  model: string;
  effort: string;
  status: number;
  latency: number | null;
  ttft: number | null;
  input: number;
  cache_read: number;
  cache_creation: number;
  output: number;
  session: string | null;
}
const hi = db.query<{ hi: number; jd: number }, []>('SELECT id AS hi, julianday(timestamp) AS jd FROM usage_events WHERE id = (SELECT MAX(id) FROM usage_events)').get();
if (!hi) throw new Error('no usage_events');
const toMs = (jd: number) => Math.round((jd - 2_440_587.5) * 86_400_000);
const to = toMs(hi.jd);
const from = to - days * 86_400_000;
const rows: UsageRow[] = db
  .query<Row, []>(
    `SELECT id, julianday(timestamp) AS jd, auth_index AS account, model, reasoning_effort AS effort, status_code AS status,
            latency_ms AS latency, ttft_ms AS ttft, COALESCE(input_tokens, 0) AS input, cache_read_tokens AS cache_read,
            cache_creation_tokens AS cache_creation, COALESCE(output_tokens, 0) AS output, session_id AS session
     FROM usage_events WHERE id > ${hi.hi} - 400000 ORDER BY id`,
  )
  .all()
  .map((r) => ({ at: toMs(r.jd), account: r.account, model: r.model, effort: r.effort, status: r.status, latencyMs: r.latency, ttftMs: r.ttft, input: r.input, cacheRead: r.cache_read, cacheCreation: r.cache_creation, output: r.output, session: r.session }))
  .filter((r) => r.at >= from && r.at < to);
db.close();

const fakeTo = Date.now();
const fake = fakeTimeline().usage(fakeTo - Math.min(days * 86_400_000, FAKE_HISTORY_MS), fakeTo);

function ranked(p: Profile): Profile {
  const order = Object.entries(p.accountShare).sort((a, b) => b[1] - a[1]);
  return { ...p, accountShare: Object.fromEntries(order.map(([, v], i) => [`#${i + 1}`, v])) };
}
const live = ranked(profile(rows, { from, to }));
const sim = ranked(profile(fake, { from: fakeTo - days * 86_400_000, to: fakeTo }));
const keys = Object.keys(live) as (keyof Profile)[];
for (const k of keys) {
  console.log(`${k}\n  live ${JSON.stringify(live[k])}\n  fake ${JSON.stringify(sim[k])}`);
}
