# cpa-deck

A local control deck for CLIProxyAPI's Claude accounts. Open `http://127.0.0.1:1338` to see which account is serving, how much session and weekly room each account has, when each window resets, which Claude resets you can claim, and the request history. You act on the accounts from the same page.

The deck is one Bun process. It binds 127.0.0.1 only. It reads keeper's SQLite read-only and talks to CPA's management API with the key from keeper's env file. `docs/design.md` is the contract and `docs/upstream.md` lists every external surface.

## Run it

To run against the real CPA:

```sh
bun install
bun run src/main.ts
```

To try or develop the deck without touching CPA, Anthropic, or keeper, run it against the fake CPA and a generated keeper DB:

```sh
bun scripts/fake-stack.ts
```

Restart the fake stack after a change. There is no hot-reload script, because `bun --hot` keeps the old poller and observer running next to the new ones.

To keep it running, install the LaunchAgent. It starts `bun run src/main.ts` in this checkout, logs to `~/Library/Logs/cpa-deck.log`, and restarts at most once every 30 s:

```sh
cp launchd/com.kinsyu.cpa-deck.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.kinsyu.cpa-deck.plist
```

These environment variables override the defaults. Tests and `scripts/fake-stack.ts` use them.

| Variable | Default |
| --- | --- |
| `CPA_DECK_PORT` | `1338` |
| `CPA_BASE_URL` | `http://127.0.0.1:8317` |
| `CPA_DECK_ENV_FILE` | `/opt/homebrew/etc/cpa-usage-keeper.env` |
| `CPA_DECK_KEEPER_DB` | `/opt/homebrew/var/cpa-usage-keeper/app.db` |
| `CPA_DECK_STATE_DIR` | `var/` in this checkout |
| `CPA_DECK_CLI_VERSION` | the output of `claude --version`, else `2.1.311` |

## Check it

```sh
bun test
bunx tsc --noEmit
bun scripts/e2e.ts
```

`scripts/e2e.ts` starts the deck on :1338 against the fake CPA and clicks every action in Chromium. It then checks that the fake recorded exactly the expected mutations. Screenshots go to `var/screenshots/` and the step log goes to `var/e2e-report.json`.

To check the real setup without changing it, run `bun scripts/live-check.ts`. It starts the deck against the real CPA and keeper and waits for the first budgeted reads, about six Anthropic calls. It prints what the page shows, probes the guard with requests that can't mutate anything, saves `var/screenshots/live.png`, and stops the deck.

## What the page shows

The overview strip comes first. It has four tiles:

- **Serving now** names the accounts with a successful request in the last 2 minutes, from keeper's request log. When keeper can't be read, CPA's response headers stand in, and the tile says so. The account a new session would land on is shown separately and labelled as a prediction.
- **Next reset** counts down to the earliest window reset, and to the earliest moment a blocked account routes again.
- **Claimable resets** lists every reset Anthropic says you can claim now, each with **Claim…**.
- **Headroom** sums session and weekly room in accounts' worth. Each account's session room is capped by its weekly room.

Each account card shows these parts:

- The routing role (serving, standby, blocked with a countdown, or disabled), the plan, and the priority.
- The read mode. At the wall, the deck reads reset programs every 3 minutes. Otherwise it reads usage every 5 minutes.
- One row per window. Each row shows the newer of the poll and the passive headers, with the other source as a faint tick. A window whose reset has passed reads "reset 14:20 ✓, awaiting fresh data" instead of its old percent. A missing session limit reads `idle`.
- Extra usage, which wall reads skip. At the wall only the header view of overage is current.
- Both Claude reset programs, with grants listed under `cedar_ember`.
- CPA's last 20 ten-minute buckets of traffic.
- One freshness chip per feed, for example "limits 4m · rate-limited 1m ago · retry 14:02".

The history panel shows stacked columns per account for 24 hours, 7 days, or 30 days, in your local time. It also has a table view, totals per model, and keeper's newest 50 errors for these accounts.

## What you can do

| Control | Effect | Safety |
| --- | --- | --- |
| **Claim…** | Opens a dialog that names the account, the program, the grant, the effect, and the age of the data behind the offer. On confirm, the server reads fresh reset data, refuses unless the offer is still claimable, then sends `reset_rate_limits` once. On `reset` or `not_limited` it calls CPA `reset-quota` up to 3 times. | Irreversible. A second click while a claim is in flight gets the same result. A timeout shows "Outcome unknown, checking" until the next read, and the claim is never resent. |
| **Enable** or **Disable** | `PATCH /auth-files/status` | Sets a value, so repeats are safe. |
| **−10**, **+10** | `PATCH /auth-files/fields` with the new priority | Sets a value. |
| **Make primary** | Sets the priority to the highest other priority plus 10, and enables the account if it is disabled. | Disabled when the account already outranks the others. A repeat writes nothing. |
| **Clear cooldown** | CPA `POST /reset-quota`. This changes CPA's local scheduler only. | Repeats are safe. |
| **Refresh token** | CPA `POST /auth-files/refresh` | The response holds tokens. `cpa.ts` keeps only `ok`. |
| Routing **fill-first** or **round-robin** | `PUT /routing/strategy` | Sets a value. |
| **↻ Read now**, **↻ Read all** | Moves the account's next Anthropic read to now. | Allowed once per 60 s per account. Never allowed during a rate-limit backoff. |
| **+ Add account** | Opens Anthropic's OAuth page in a new tab. The server polls CPA until the new account appears. | One flow at a time. A flow expires after 5 minutes. |

Every button shows a spinner while its action runs, a check when it succeeds, and the server's message when it fails. A CPA mutation answers only after the server has re-read CPA, so the card already shows the new state when the spinner stops.

## HTTP API

The UI polls `GET /api/snapshot` every 2 s and again right after each action. Then it runs `deriveDeck(snapshot, now)` from `src/shared/derive.ts` once a second, so countdowns and ages stay live between polls. The server calls the same functions to pick the read mode and to decide whether a claim is allowed.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | The UI, bundled in memory at startup |
| GET | `/api/snapshot` | `Snapshot` from `src/shared/domain.ts`: facts only, one writer per part |
| GET | `/api/history?range=24h\|7d\|30d` | `HistoryView`: UTC-hour rows per account and model, per-model totals, and recent errors |
| POST | `/api/act` | Body `{kind, input}` for one row of `ACTIONS` in `src/shared/actions.ts`. Returns the row's output or `{error: {code, message}}`. |

Every route rejects a `Host` other than `127.0.0.1:1338` or `localhost:1338` with 421. Every POST also needs `X-CPA-Deck: 1` and `Content-Type: application/json`. A cross-origin page can't send either header without a preflight, and the server answers no preflight and sends no CORS headers. An `Origin` header, when present, must match the page.

For example, to read which accounts have a claimable weekly reset:

```sh
curl -s 127.0.0.1:1338/api/snapshot | jq '.feeds | map_values(.juniper.last.value.available)'
```

## What it never does

`test/boundaries.test.ts` fails the build if the source breaks one of these rules.

- It never consumes CPA's usage queue, and it never writes to keeper's DB. keeper is opened `mode=ro` with `query_only`.
- It never sends a management request without the key, and it never sends the key anywhere but CPA. Requests go to CPA one at a time, so a wrong key meets one 401 and the requests behind it fail without sending. The 401 or 403 records the key's hash in `var/state.json`, and that key is not tried again for 35 minutes. Each distinct key costs at most one strike per ban window, across restarts, which keeps the deck under CPA's 5-strike IP ban. A changed key is tried at once.
- It never forwards token material.
- It never calls Anthropic more than once per 10 s overall. A 429 backs off that account for its `retry-after`, or else for 5, 10, 20, then 30 minutes. `var/state.json` keeps each account's recent usage reads and its backoff, so a restart loop reads no more often than one long-lived process and the backoff keeps climbing.
