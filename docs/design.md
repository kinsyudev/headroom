# Headroom design

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
| GET | `/api/usage` | `UsageCube`: the last 31 days of usage in hourly cells, plus recent error events. The UI polls it every 60 s, or every 2 s while `catchingUp` is true. |
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
- Claude Code only reads `at_wall` at the wall, and Headroom mirrors that. Away from the wall, juniper_tide shows as `held`, meaning it is offered at the wall, with its last known value and age if one exists.
- **Budget rules.** `anthropic.ts` enforces them at the one place requests leave:
  - At least 10 s between any two Anthropic calls, process-wide.
  - At most 8 usage reads per account in any rolling 15 minutes, two thirds of the ~12 that earned a 429. The cap counts every kind of read: scheduled, manual, and a claim's fresh read. While the cap is full, the card shows when the next read is allowed, and a claim answers `not_claimable` with that time.
  - Stagger the first poll per account by 15 s after start.
  - On a 429, back off that account only. Honor `retry-after` when present, otherwise use 5, 10, 20, then 30 min, capped. Reset the backoff on a successful usage read. A profile 2xx does not reset it, because the usage endpoint is the one Anthropic limits.
  - A restarted process continues the same budget. At start, the scheduler takes each account's last usage read from `var/state.json`, so a restart loop reads no account more often than one long-lived process would.
  - A manual refresh moves an account's next read to now. It is allowed once per 60 s per account, and never during backoff or while the cap is full.
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
  2. If an earlier claim still holds the program, return `not_claimable`. Check before the fresh read and again against it. The rule is `holdingClaim` in `derive.ts`, the same function the offer uses. A claim holds while it is `sending`. Once it is `maybe_sent` or `settled`, it holds until a read of that program taken at least `SETTLE_LAG_MS` (60 s) after the claim ended. A read answered before Anthropic applied the claim still shows the old offer, and 60 s is longer than Anthropic's 25 s claim timeout.
  3. Force one `wall` read for the account, subject to backoff and the read cap. If the read can't be made, return `not_claimable: stale` with when a read is next allowed.
  4. Run `deriveOffers` on that fresh sample. If the offer isn't `claimable`, return `not_claimable` with `explainOffer()`.
  5. Send `POST /api/organizations/{org}/reset_rate_limits` once. Use `{program:'juniper_tide'}`, or `{program:'cedar_ember', grant_id, request_id: crypto.randomUUID()}`. Never retry automatically.
  6. On `reset` or `not_limited`, call CPA `POST /reset-quota {auth_index}`. Try at most 3 times, 2 s apart. If it still fails, report that the claim succeeded but CPA's cooldown wasn't cleared, and point at **Clear cooldown**.
  7. Record the in-memory result: `settled{outcome, followup}`, or `maybe_sent{at}` on a timeout or network error. Then ask the poller for a `wall` read `SETTLE_LAG_MS` after the claim ended, the read that releases the hold. Reads stay `wall` until one succeeds, still subject to backoff and the read cap, because an account the claim took off the wall would otherwise get only `normal` reads, which never carry juniper_tide.
- **Crash safety without a journal.** The precondition in step 3 is a fresh upstream read. A claim that landed before a crash shows up as `available:false` or a lower `resets_left`, so a re-claim is refused. A claim that didn't land stays claimable, which is correct. `maybe_sent` is shown as "Outcome unknown, checking", never as failed.
- The last 20 claim results stay in memory in `Snapshot.claims` so the UI can show the outcome.

### 4. Persisted state: one small JSON file

The file is `var/state.json`, gitignored, and always written atomically (temp file plus rename). It holds:

- `rejectedKeys: {keyHash, at}[]`. A 401 or 403 from CPA adds the key's sha256. While the env key's hash is in the list with `at` under 35 min old, send nothing and show the rejected banner. The list holds every key rejected in that window, so switching from key A to key B and back to A does not retry A. The process never exits on a rejected key.
- `budgets: {[accountId]: {reads, backoff}}`, so a LaunchAgent restart loop can't burst Anthropic. `reads` holds the send time of each usage read in the last 15 min, recorded before the request leaves. `backoff` is `{until, streak} | null`, and `streak` picks the ladder step, so the ladder keeps climbing across restarts.

There is nothing else. No SQLite of our own.

### 5. Transport and guard

- SSE is dropped. The UI polls `/api/snapshot` every 2 s. The server builds the snapshot from in-memory owners, so each poll is cheap.
- The `/api/session` CSRF token is dropped. The guard is:
  - Host allowlist (`127.0.0.1:1338`, `localhost:1338`), against DNS rebinding.
  - Every POST requires `X-Headroom: 1` and `Content-Type: application/json`. A custom header can't be sent cross-origin without a preflight, and we never answer preflights.
  - `Origin`, when present, must be same-origin.
  - The server sends no CORS headers.
- `Secret` from candidate 2 wraps the management key and redacts itself in `JSON.stringify`, template literals, and `inspect`.
- `cpa.ts` sends management requests one at a time, and each one reads the latch when it reaches the front of the queue. Concurrent requests would each meet the wrong key before the first 401 came back, at startup and again when CPA reloads a new key under a running Headroom. One at a time, a wrong key costs exactly one strike. The cost is that a slow `api-call` delays the CPA reads queued behind it. An Anthropic call through CPA usually takes under a second. The 20 s read timeout and the 35 s claim timeout bound the delay.

### 6. Derivations to add (from candidate 3)

- **Window lifecycle.** Each limit row is `open`, `idle`, or `lapsed`.
  - `lapsed` means `resetsAt` has passed and no newer data has arrived. Show "14:20 ✓ · awaiting data", with "reset 14:20 ✓ · awaiting fresh data" on hover, never the old reading.
  - `idle` means the session limit is absent from `limits[]`, so no session window is running. It reads "100%" and "starts on first request". Fixture 1 shows this.
- **One direction.** The page says how much is left and never how much is used, on every meter, tooltip and the Room left tile. A view's `left` is 100 minus the used percent, floored at 0. The wall, severity and trouble are still judged on the used percent, and a critical window tints its track red, outlines it thinly in red and draws its figure in red. Its bar is still as long as what is left, so a window with nothing left is an empty track. A column says "left" once, in its header ("Session left"), and its cells show bare percents; where the headers are hidden the row label carries it. A normal window with more than half left (`tone: 'ample'`) draws a softer fill than one running low. The Room left tile pools nothing. It counts the open accounts and shows the serving account and the next one in line with the same `left` figures their rows draw, because an average of a blocked account and an idle one matches no account the operator can act on.
- **Serving now comes from keeper.** Every 5 s, `keeper.ts` reads the most recent `usage_events` (newest 500 rows by `id`) grouped by `auth_index`, giving last-seen time and request count in the last 2 min. An account is serving if it was last seen under 120 s ago. The tile also says whether that account takes the next new session, or names the account that will, which is a prediction from the routing rule. CPA's `recent_requests` is the fallback when keeper is unavailable.
- **Merging header and poll data.** Both sources map to the same rows (`5h` to session, `7d` to weekly_all). The newer observation is drawn, and the other is named with its age in the cell's tooltip. The meter carries no mark for it.

### 7. Usage history

Every chart reads one shape, and the server never answers per range or time zone.

**The server keeps an hourly ledger.** `src/server/ledger.ts` folds `usage_events` rows into cells keyed by UTC hour, account, model, and reasoning effort. Each cell holds counts per outcome (ok, 429, 499, 5xx, other), token sums, the sessions that started in it, and log-binned latency and time to first token of ok requests. The ledger is pure and has no SQLite in it. It owns the one cursor, the highest `usage_events` id folded, so a row counts once however its reads are sliced or replayed. A late row with an old timestamp still lands in its own hour.

**`keeper.ts` reads by primary key only.**

- `keeper.ts` is the only file that names `input_tokens`. Its SQL computes fresh input as `input - cache_read - cache_creation`.
- At start, it finds the first id inside the horizon (31 days, the longest range plus a day) by binary search on the primary key, comparing instants in JS.
- It reads 2,000 rows per slice, each slice in its own macrotask, so `/api/snapshot` answers between slices. On the live DB (107k rows in the horizon, 2026-11-05) the warm-up took 0.14 s, and the longest block of the event loop was 2.3 ms, or 6.5 ms on a cold first run.
- After the warm-up, the 5 s tick and every `/api/usage` request read the tail first, so an answer is current to keeper's newest row.
- If keeper's newest id falls below the cursor, the DB was replaced, and the ledger starts over.
- Nothing is persisted. A restart reads the horizon again, and eviction leaves the same cells a fresh read gives.
- `test/keeper.test.ts` runs `EXPLAIN QUERY PLAN` on every statement in `SQL` and fails on any `SCAN usage_events`. A `julianday(timestamp)` filter in a `WHERE` reads the whole table.

**`GET /api/usage` returns the `UsageCube` as is.** It takes no parameters. While the warm-up runs, it answers 200 with what is folded so far and `catchingUp: true`. It returns 503 only when keeper can't be read. The body is about 0.6 MB for 31 days. It carries no session ids and no error bodies, only the message parsed out of each body.

**The browser folds the cube.** `deriveAnalytics(cube, lens, accounts)` in `src/shared/usage.ts` is the only reader of the cube, and `useAnalytics(lens, accounts)` in `src/ui/api.ts` is the only caller. A lens is a range (24h, 7d, or 30d), a grain (hour or day), and an optional account and model. Changing it re-folds in memory with no request. The view holds:

- Buckets in browser-local time. They are contiguous and zero-filled. Day buckets step by calendar date, so a DST day is 23 or 25 hours. The last bucket is `partial` because its end is after the cube's `generatedAt`, and the chart draws it striped and labels it "now".
- Breakdowns by account, model, and effort that line up with fixed dimensions in every bucket. Accounts follow deck order, so colors stay stable.
- A local weekday-by-hour grid, the account-and-model table, and the error events inside the span.
- Rates per outcome, cache-read share of input, output per request and per session, and latency and TTFT percentiles. A percentile lies in the bin of the true value, within 19%, and is null under 20 samples.

**Pace comes from the quota reading alone.** `QUOTA_WINDOWS` in `derive.ts` is the one list of window kinds, the header that reports each one, and its length. From it, `mergeLimits` gives every open `LimitView` a `pace`: when the window opened, how much of it is gone, used against elapsed, and whether a straight line at the burn so far reaches the limit before the reset. The analytics view adds what the window has cost so far, from the cube.

**Not handled.** keeper's `usage_events_archive` is empty. If keeper ever moves rows younger than 31 days to the archive, the cube keeps counting the rows it already read until the next restart. The rebuild rule catches a deletion only when it removes the newest ids. Rows are treated as immutable once keeper writes them.

### 8. Stack and runtime

- Bun 1.3, TypeScript, React 19, and zod. Charts are hand-written SVG; read the `dataviz` skill before writing chart code.
- Port 1338.
- LaunchAgent `com.kinsyu.headroom` runs `/Users/kinsyu/.bun/bin/bun run src/main.ts`, with this repo as its working directory. Logs go to `~/Library/Logs/headroom.log`. It sets `KeepAlive` and `ThrottleInterval 30`.

### 9. Views, lenses and the brand

The page has two views, Monitor and Usage, chosen by the hash (`#usage` opens Usage and any other hash is Monitor, so a jump link to a card stays on Monitor). Usage is a separate view and not a long section, so the glance at the top of Monitor stays as short as it was and a capture of Usage can be read in 1000 px tiles. Monitor keeps one chart, the Activity panel, because it is about the accounts on the page. Everything else about history lives in Usage.

- **Three lenses read one cube.** Usage calls `useAnalytics` three times and none of them refetches. `all` is 30 days with no filters, and feeds the quota pace and the model list. `explore` follows the toolbar. `pattern` is 30 days with the toolbar's account and model, because a weekly rhythm needs a month. `deriveAnalytics` memoizes each fold per lens, so three calls cost one fold each.
- **One range holds the numbers together.** The toolbar leads the Usage view and opens on 7 days. The headline row and every chart below it read `explore`, so a figure in a tile is the figure its chart adds up to. Only the weekday-by-hour grid and the busiest-weekday tile read the month, and say so.
- **`previous` is the same stretch one range earlier.** `AnalyticsView.previous` and each `TimeBucket.previous` hold the span 24 hours, 7 days or 30 days before, by local calendar, narrowed by the same lens. The span still running is cut at `asOf` less that shift, so it meets as much of the earlier span as it has itself, and the hour holding the cut counts in full. It is null for 30d, because the history reaches back only a month and a day, and null until the history reaches back to the start of the earlier span, so a short span never reads as a drop. The headline deltas and the dim sparkline bars use the view's `previous`. The same-day-last-week marks on the 7-day usage chart use each bucket's.
- **One direction, one meter.** The meter draws what is left, in four tones. `MeterTone` adds `low` (a quarter or less left) beside `ample`, `normal`, `warning` and `critical`. `LimitPace.projected` and `endsAt` turn pace into words without the component doing arithmetic on windows. The steady-pace tick sits at 100 less the share of the window gone.
- **A chart is a form chosen by the data's job** (the dataviz skill): stacked columns for parts of a total over time, a grid for weekday by hour, a bar list for shares, lines for percentiles, a bullet bar for pace against time. Every chart starts at zero, has one axis, keeps its legend for two or more series, has a tooltip, and has a table twin in the same card. A share that is nearly the whole (cache) is not drawn as a wall of 100% columns. The headline carries the large share, and the chart plots the small remainder, what missed the cache, as columns from zero on a scale that opens at 10% and says so in its subtitle, so a short bar is never read against 100%. One chart holds one idea: speed is one panel with a First token and Finish switch, not two stacked copies.
- **Color has one job each.** Account identity is `--id-1` to `--id-5`, magnitude is the ice ramp, and status is green, amber and red. A failure series is a status, so it wears the status colors with a glyph. 499 is the client hanging up, so it stays gray.
- **Palette checks are a test.** `test/palette.test.ts` reads `:root` in `styles.css` and fails when a text token drops under 4.5:1 on any surface, a mark token under 3:1, or two neighbouring account colors, or an account color and a status color, come within 15 of each other.
- **Every frame hangs from a lit ceiling.** Each stat tile, panel, card, the toolbar, the claim dialog, and the tooltips and menus have a top border in `--ceiling-edge`, a dim ice. A frame with a name also carries the line over "room", a 22px bar in `--ceiling`, on that edge and in line with its title, so the mark sits where the reader starts reading. The current tab and a selected toggle carry the same bar, so a selected state is never only a lighter gray. `--ceiling` turns gray while CPA is down, because every reading on the page is frozen. While a frame is busy or its chart is dimmed for a refresh, the bar travels along the edge, unless the reader asks for reduced motion. Meters and charts carry the line only as a real limit, such as the 100% cap on the cache-hit bar.
- **Names in Hubot Sans Expanded, numbers in the system face.** The wordmark, every frame title and every uppercase label use `--display`, Hubot Sans Expanded, committed in `src/ui/fonts/` under the SIL Open Font License. Hubot's zero is slashed, so its `@font-face` rules leave out the digits and a number inside a title falls through to the system face. Every number on the page therefore uses the system face with tabular figures, set once on `body`. Every figure set large (`.hero.num`, `.kpi-value`, `.figure`) uses that face at its expanded width, heavier than the text around it. The serving account's address is a name and not a figure, so it keeps proportional figures.

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
- We accept about 0.6 MB of JSON per minute on localhost, in exchange for one shape that every chart reads and lens changes that make no request.
- We accept UTC-hour cells, which misfold half-hour zones by 30 minutes, and pace costs that count whole hours from the hour the window opened.
- We accept that the fake keeper's account1 keep-alive is about a fifth of its requests and lifts the overnight trough, so the e2e's serving check holds at any hour.
- Delete account is out of scope. Use CPA's own panel for it.

## Alternatives considered

The arena's rejected whole shapes still hold:

- A server-built view with a dumb client. Time-dependent conclusions go stale between pushes.
- A Go server with htmx, or with a separate SPA. Types and derivation would exist twice.
- A thin key-injecting proxy with logic in the browser. It leaks wire types, polls per tab, and can't hold the lockout latch.
- A collector process plus a web server. It breaks the one-process constraint.
