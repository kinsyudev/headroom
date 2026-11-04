# cpa-deck design

This document is the contract for the implementation. The scaffold in `src/` and `test/` is candidate 1 from the design arena. This document changes that scaffold, and where the two disagree, this document wins. The external surfaces are specified in `docs/upstream.md`.

## Problem

The operator runs CLIProxyAPI (CPA) with three Claude OAuth accounts under fill-first routing. They want one local page that answers four questions:

- Which account is serving traffic right now?
- How much session and weekly headroom does each account have?
- When does each limit reset?
- Is a Claude reset available to claim?

The same page must also act on the accounts. The facts come from four sources, and each has different freshness and failure modes:

- CPA `/auth-files` is cheap, local, and passive. Its header snapshot only moves with traffic.
- Anthropic `/api/oauth/usage` through CPA `api-call` is authoritative. It is rate-limited per account: about 12 calls per account in 15 minutes earned a 429.
- Anthropic profile.
- Keeper SQLite holds history. It is read-only, and its timestamps carry a `+08:00` offset.

The shape has to respect three hazards:

- An irreversible reset claim.
- CPA's 5-strike management-key IP ban, which also locks out keeper.
- That rate limit.

## Usage (caller's view)

`README.md` is the operator-facing spec. Its screen mockup and control table are still right, with the changes below. The UI calls these routes:

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | The app, a Bun HTML import |
| GET | `/api/snapshot` | `Snapshot`. The UI polls this every 2 s and immediately after every action. |
| GET | `/api/history?range=24h\|7d\|30d` | `HistoryView` |
| POST | `/api/act` | `{kind, input}` returns the typed output, or `{error: {code, message}}` |

The UI runs `deriveDeck(snapshot, now)` once a second. The server calls the same exported functions when it needs a conclusion, such as whether a reset is claimable or what the make-primary priority should be.

## Shape

These parts of candidate 1 stay as they are:

- `Snapshot` holds facts only, and each part has one writer.
- `deriveDeck` is the only place facts become conclusions.
- `shared/actions.ts` is the one action table that the parser, handlers, and `act()` derive from.
- `Cpa` is the only module that sends the management key.
- `refreshToken` parses down to `{ok}`.
- `boundaries.test.ts` stays.

### 1. Anthropic polling: one read per account per cycle (replaces candidate 1's cadence)

All three candidates polled two usage endpoints at 60 s, which contradicts the measured rate limit. The replacement uses two read modes and never runs both in one cycle for the same account.

| Read | URL path | Carries | When |
| --- | --- | --- | --- |
| `normal` | `/api/oauth/usage?cedar_ember=1` | `limits[]`, `spend`, `cedar_ember` (verified live 2026-11-04) | every 5 min per account |
| `wall` | `/api/oauth/usage?at_wall=1&skip_spend=1` | `limits[]`, `juniper_tide`, `cedar_ember` | instead of `normal`, every 3 min, while the account is at the wall |
| profile | `/api/oauth/profile` | org uuid, plan, tier | at start, then every 6 h |

- **At the wall** means at least one of these holds. It is a pure function in `derive.ts`, `isAtWall`, which the scheduler and the UI share.
  - Any limit's `percent >= 100`.
  - The header snapshot `status === 'rejected'`.
  - A live credential-scope cooldown whose reason is `quota` or `credential_quota`.
- Claude Code only reads `at_wall` at the wall, and the deck mirrors that. Away from the wall, juniper_tide shows as `held`, meaning it is offered at the wall, with its last known value and age if one exists.
- **Budget rules.** `anthropic.ts` enforces them at the one place requests leave:
  - At least 10 s between any two Anthropic calls, process-wide.
  - Stagger the first poll per account by 15 s after start.
  - On a 429, back off that account only. Honor `retry-after` when present, otherwise use 5, 10, 20, then 30 min, capped. Reset the backoff on success.
  - A manual refresh moves an account's next read to now. It is allowed once per 60 s per account and never during backoff.
- **Claude Code identity.** Send `User-Agent: claude-cli/<version> (external, cli)` and `x-app: cli` on every Anthropic call. At startup, read `<version>` from `claude --version`. If that fails, fall back to `2.1.311`. Without these headers, every program reads `ineligible: surface`.

### 2. Feeds split by which read writes them

```ts
interface AccountFeeds {
  limits: Source<readonly Limit[]>;   // normal + wall; newer success wins
  spend:  Source<Spend | null>;       // normal only
  cedar:  Source<CedarEmber | null>;  // normal + wall
  juniper: Source<JuniperTide | null>;// wall only (normal reads always return null for it)
  profile: Source<Profile>;
}
interface Source<T> { last: Sample<T> | null; error: Sample<SourceError> | null; attemptedAt: Instant | null; nextAt: Instant | null }
```

`attemptedAt` comes from candidate 2. It lets the freshness chip say "data 4 m old, rate-limited 1 m ago, retry 14:02".

### 3. Reset claims: upstream status is the ledger (replaces candidate 1's deck.db journal)

Per make-operations-idempotent, each step is derived from the state that exists. For a reset, the state that exists is Anthropic's program status. A local journal would be a second copy of that state, and it could disagree with the first. So:

- There is one action, `claim`, with input `{account, program, grant?}`. The prepare/confirm split goes away. The confirm dialog shows the client-derived offer and the age of the data behind it.
- On the server, `claims.ts` runs these steps for each (account, program):
  1. If a claim for this (account, program) is `sending`, return the same in-flight promise. That covers a double-click or a second tab.
  2. Force one `wall` read for the account, subject to backoff. If the read can't be made, return `not_claimable: stale`.
  3. Run `deriveOffers` on that fresh sample. If the offer isn't `claimable`, return `not_claimable` with `explainOffer()`.
  4. Send `POST /api/organizations/{org}/reset_rate_limits` once. Use `{program:'juniper_tide'}`, or `{program:'cedar_ember', grant_id, request_id: crypto.randomUUID()}`. Never retry automatically.
  5. On `reset` or `not_limited`, call CPA `POST /reset-quota {auth_index}`. Try at most 3 times, 2 s apart. If it still fails, report that the claim succeeded but CPA's cooldown wasn't cleared, and point at **Clear cooldown**.
  6. Record the in-memory result: `settled{outcome, followup}`, or `unknown{at}` on a timeout or network error. Then schedule an immediate `wall` read.
- **Crash safety without a journal.** The precondition in step 2 is a fresh upstream read. A claim that landed before a crash shows up as `available:false` or a lower `resets_left`, so a re-claim is refused. A claim that didn't land stays claimable, which is correct. `unknown` is shown as "Outcome unknown, checking", never as failed.
- The last 20 claim results stay in memory in `Snapshot.claims` so the UI can show the outcome.

### 4. Persisted state: one small JSON file

The file is `var/state.json`, gitignored, and always written atomically (temp file plus rename). It holds:

- `rejectedKeys: {keyHash, at}[]`. A 401 or 403 from CPA adds the key's sha256. While the env key's hash is in the list with `at` under 35 min old, send nothing and show the rejected banner. The list holds every key rejected in that window, so switching from key A to key B and back to A does not retry A. The process never exits on a rejected key.
- `backoff: {[accountId]: untilMs}`, so a LaunchAgent restart loop can't burst Anthropic.

There is nothing else. No SQLite of our own.

### 5. Transport and guard

- SSE is dropped. The UI polls `/api/snapshot` every 2 s. The server builds the snapshot from in-memory owners, so each poll is cheap.
- The `/api/session` CSRF token is dropped. The guard is:
  - Host allowlist (`127.0.0.1:1338`, `localhost:1338`), against DNS rebinding.
  - Every POST requires `X-CPA-Deck: 1` and `Content-Type: application/json`. A custom header can't be sent cross-origin without a preflight, and we never answer preflights.
  - `Origin`, when present, must be same-origin.
  - The server sends no CORS headers.
- `Secret` from candidate 2 wraps the management key and redacts itself in `JSON.stringify`, template literals, and `inspect`.
- `cpa.ts` sends management requests one at a time, and each one reads the latch when it reaches the front of the queue. Concurrent requests would each meet the wrong key before the first 401 came back, at startup and again when CPA reloads a new key under a running deck. One at a time, a wrong key costs exactly one strike. The cost is that a slow `api-call` delays the CPA reads queued behind it. An Anthropic call through CPA usually takes under a second. The 20 s read timeout and the 35 s claim timeout bound the delay.

### 6. Derivations to add (from candidate 3)

- **Window lifecycle.** Each limit row is `open`, `idle`, or `lapsed`.
  - `lapsed` means `resetsAt` has passed and no newer data has arrived. Show "reset at 14:20 ✓, awaiting fresh data", never the old percent.
  - `idle` means the session limit is absent from `limits[]`, so no session window is running. Fixture 1 shows this.
- **Serving now comes from keeper.** Every 5 s, `keeper.ts` reads the most recent `usage_events` (newest 500 rows by `id`) grouped by `auth_index`, giving last-seen time and request count in the last 2 min. An account is serving if it was last seen under 120 s ago. Fill-first's predicted target is shown alongside and labeled as a prediction. CPA's `recent_requests` is the fallback when keeper is unavailable.
- **Merging header and poll data.** Both sources map to the same rows (`5h` to session, `7d` to weekly_all). The newer observation is drawn, and the other is shown as a faint tick with its age.

### 7. History

- `keeper.ts` is the only file that names `input_tokens`. It computes fresh input as `input - cache_read - cache_creation`.
- Range filtering uses `julianday(timestamp)`.
- The server returns sparse hourly rows bucketed in UTC (`strftime('%Y-%m-%dT%H:00:00Z', timestamp)`) for the range, per account and model.
- The browser folds those rows into local hours or days. That keeps timezone and DST handling out of SQL.
- The response also carries per-model totals over the range and the 50 most recent `error_events` for the known accounts.
- Results are memoized per range for 30 s.

### 8. Stack and runtime

- Bun 1.3, TypeScript, React 19, and zod. Charts are hand-written SVG; read the `dataviz` skill before writing chart code.
- Port 1338.
- LaunchAgent `com.kinsyu.cpa-deck` runs `/Users/kinsyu/.bun/bin/bun run src/main.ts`, with this repo as its working directory. Logs go to `~/Library/Logs/cpa-deck.log`. It sets `KeepAlive` and `ThrottleInterval 30`.

## Synthesis decision

Three runners produced candidates: opus as candidate 1, fable as candidate 2, sonnet as candidate 3. All three converged on the same whole shape: one Bun process, a pure derive shared by server and browser, one action union, and a never-resend claim rule. That convergence counts as strong agreement.

**Base: candidate 1.** The cross-judge (fable) recommended candidate 3. By the judge's own per-criterion scores, though, candidate 1 totals 25, candidate 3 totals 23, and candidate 2 totals 22. Candidate 1 also has 35 files where candidate 3 has 54, and it already has a test plan, while candidate 3 had no `test/` at all.

**Grafts:**

- From candidate 3: the window lifecycle (`open/idle/lapsed`), keeper-observed serving, poll gate state that survives restarts, and enforcing the poll budget at the one place requests leave.
- From candidate 2: `attemptedAt`, the `Secret` redaction class, a custom-header guard with no token endpoint, a test plan written as truth tables, and forcing a fresh read before a claim.

**Changes to every candidate:**

- The poll policy now matches the measured rate limit.
- The durable claim ledger is replaced by "fresh upstream read before send" plus an in-process lock (section 3).
- SSE is replaced by 2 s polling.
- Tests point at the real 200 fixtures. All three candidates believed the fixtures were 429s.

**Rejected:**

- Candidate 3's typed confirmation phrase. A dialog that names the account, program, and effect is enough for a once-a-week action.
- Candidate 3's `cache.json` and `ledger.sqlite`.
- Candidate 1's prepare/confirm phases.

## Tradeoffs accepted

- We accept that a claim outcome is lost from the UI if the process restarts mid-claim, in exchange for having no local journal. The next `wall` read shows the true program state.
- We accept limits data up to 5 min old away from the wall, in exchange for staying inside Anthropic's rate limit. Passive CPA headers keep the serving account live in between.
- We accept that juniper_tide shows as `held` away from the wall, in exchange for reading `at_wall` only when Claude Code would.
- We accept a 2 s poll of a local endpoint, in exchange for no SSE connection state or idle timeouts.
- We accept no cost column, because keeper has no prices configured.
- Delete account is out of scope. Use CPA's own panel for it.

## Alternatives considered

The arena's rejected whole shapes still hold:

- A server-built view with a dumb client. Time-dependent conclusions go stale between pushes.
- A Go server with htmx, or with a separate SPA. Types and derivation would exist twice.
- A thin key-injecting proxy with logic in the browser. It leaks wire types, polls per tab, and can't hold the lockout latch.
- A collector process plus a web server. It breaks the one-process constraint.
