# Headroom

Headroom is a local dashboard for CLIProxyAPI's Claude accounts. Open `http://127.0.0.1:1338` to see which account is serving, how much session and weekly room each account has, when each window resets, which Claude resets you can claim, and the request history. You act on the accounts from the same page.

Headroom is one Bun process. It binds 127.0.0.1 only. It reads keeper's SQLite read-only and talks to CPA's management API with the key from keeper's env file. `docs/design.md` is the contract and `docs/upstream.md` lists every external surface.

## Run it

To run against the real CPA:

```sh
bun install
bun run src/main.ts
```

To try or develop Headroom without touching CPA, Anthropic, or keeper, run it against the fake CPA and a generated keeper DB:

```sh
bun scripts/fake-stack.ts
```

Restart the fake stack after a change. There is no hot-reload script, because `bun --hot` keeps the old poller and observer running next to the new ones.

To keep it running, install the LaunchAgent. It starts `bun run src/main.ts` in this checkout, logs to `~/Library/Logs/headroom.log`, and restarts at most once every 30 s:

```sh
cp launchd/com.kinsyu.headroom.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.kinsyu.headroom.plist
```

To restart it after pulling changes, or to stop it:

```sh
launchctl kickstart -k gui/$(id -u)/com.kinsyu.headroom
launchctl bootout gui/$(id -u)/com.kinsyu.headroom
```

These environment variables override the defaults. Tests and `scripts/fake-stack.ts` use them.

| Variable | Default |
| --- | --- |
| `HEADROOM_PORT` | `1338` |
| `CPA_BASE_URL` | `http://127.0.0.1:8317` |
| `HEADROOM_ENV_FILE` | `/opt/homebrew/etc/cpa-usage-keeper.env` |
| `HEADROOM_KEEPER_DB` | `/opt/homebrew/var/cpa-usage-keeper/app.db` |
| `HEADROOM_STATE_DIR` | `var/` in this checkout |
| `HEADROOM_CLI_VERSION` | the output of `claude --version`, else `2.1.311` |

## Check it

```sh
bun test
bunx tsc --noEmit
bun scripts/e2e.ts
```

`scripts/e2e.ts` starts Headroom on :18338 against the fake CPA and clicks every action in Chromium. It then checks that the fake recorded exactly the expected mutations. Screenshots go to `var/screenshots/` and the step log goes to `var/e2e-report.json`.

To check the real setup without changing it, stop the LaunchAgent and run `bun scripts/live-check.ts`. It starts its own Headroom on :1338 against the real CPA and keeper and waits for the first budgeted reads, about six Anthropic calls. It prints what the page shows, probes the guard with requests that can't mutate anything, saves `var/screenshots/live.png`, and stops Headroom.

## What the page shows

The header ends with one status line. It reads "Live · updated 3s ago" while CPA, the routing strategy and the history log are all fresh. When one of them is aging, stale or failing, the line names that source in color instead, for example "History not updated for 6m" or "CPA not answering". Hover it for each source's age and what it feeds. When CPA stops answering, the dot beside the title turns red and that line reads "CPA not answering". One banner under the header says when CPA last answered, and every button that calls CPA is disabled until it does.

The overview strip comes first. It has four tiles:

- **Serving now** headlines the account with the newest successful request in the last 2 minutes, from keeper's request log. When keeper can't be read, CPA's response headers stand in, and the tile's tooltip and a banner say so. The line under it gives the age of that request and either "also takes the next new session" or the account a new session would land on instead. Any other account that answered in the window is named on a last line.
- **Next reset** counts down to the earliest window reset, and to the earliest moment a blocked account routes again. When the account that resets first also unblocks within a minute of it, the reset line ends with "unblocks then" instead of a second line.
- **Claimable resets** lists every reset Anthropic says you can claim now, grouped under its account. Each reset is named by what it does and where it comes from, for example "Session reset · weekly allowance" or "Session reset · grant" with how many grant resets are left beside it, and has its own **Claim…**. The account card and the claim dialog use the same names.
- **Headroom** shows **Session room** and **Weekly room** as "1.72 of 3 accounts", counting each enabled account as 1.00 when all of its room is left. Each account's session room is capped by its weekly room, and the tile's tooltip says so.

Below 1010 px of window width the tiles sit in two columns and each is as tall as its content. Serving now sits over Next reset on the left, and Claimable resets over Headroom on the right.

Each account card is as tall as its content. Cards sit three across from 1180 px of window width, two across from 860 px, and one below that. Each card shows these parts:

- The routing role (serving, standby, blocked with a countdown, or disabled) and the plan.
- One reason line when an account is cooling down or CPA reports an error for it, for example "Monthly spend limit hit · account and 3 models cooling down until 22:15". The countdown is the one on the Blocked badge, so the line gives only the clock time. A cooldown that ends at a different time than the badge's gets its own countdown. The cause is CPA's message where it maps to a known phrase, and the cooldown reason otherwise. **Details** opens the per-model list with CPA's reason codes and its full message. A card with no trouble shows no such line.
- One status line with the read mode, the age of the freshest successful usage read, and when the next read is due, for example "Normal · read 22s ago · next read in 4m 38s". When the account is at its limit the badge reads "At limit" and Headroom reads reset programs every 3 minutes. Otherwise it reads usage every 5 minutes. A feed that is aging, stale or failing shows in color on the line, for example "limits read failing · retry in 2m". While CPA is not answering, "reads paused" stands where the next read would be. A feed held by design, such as the weekly reset away from the limit, is not on the line. Hover the line for every feed's age, last error and next read, held feeds included.
- One row per window with the meter, the percent, a "limiting" tag on the window that holds the account back (Anthropic's active window, once it is at warning or critical), and the reset as the countdown then the clock time, for example "4h 32m · 23:00". Hover the reset for "resets 23:00 · in 4h 32m". Each row shows the newer of the poll and the passive headers, with the other source as a faint tick. Hover the rest of the row for both readings and their ages. A window whose reset has passed reads "14:20 ✓ · awaiting data" instead of its old percent. A missing session limit reads `idle` and "no window running". In a card narrower than 340 px the countdown and the clock time stack on two lines.
- Extra usage, which wall reads skip. While the account is at its limit only the header view of overage is current.
- Both Claude reset programs. A claimable one shows its **Claim…** button and no status text. Grants are listed under `cedar_ember` as how many resets are left and when the grant ends. With more than one grant, each line also gives the grant's name and what it clears. When nothing on the card is claimable, waiting, in flight or unreadable, they collapse to one quiet line such as "none to claim · weekly reset offered at limit · no grants". Click the line to open each program's detail. A narrow card clips the line after the last phrase that fits.
- CPA's last 20 ten-minute buckets of traffic.

The history panel shows stacked columns per account for 24 hours, 7 days, or 30 days, in your local time. It also has a table view, totals per model, and keeper's newest 50 errors for these accounts. Below 1010 px of window width the per-model table shows the **Usage** columns (requests, failed, 429s and output), and the **Cache and latency** switch above it swaps in the uncached input, cache read, cache write, latency and first-token columns. A table that is still wider than the panel scrolls sideways and fades the edge that has more.

## What you can do

| Control | Effect | Safety |
| --- | --- | --- |
| **Claim…** | Opens a dialog that names the account, the reset type (with its raw program code in small type), the grant, the effect, when the limit would reset on its own without the claim, and the age of the data behind the offer. On confirm, the server reads fresh reset data, refuses unless the offer is still claimable, then sends `reset_rate_limits` once. On `reset` or `not_limited` it calls CPA `reset-quota` up to 3 times. | Irreversible. A second click while a claim is in flight gets the same result. After a claim ends, the program stays held until a read taken at least a minute later shows the outcome, and the server refuses another claim for it until then. A timeout shows "Outcome unknown, checking" for that time, and the claim is never resent. |
| **Enable** or **Disable** | `PATCH /auth-files/status` | Sets a value, so repeats are safe. |
| **Priority** − and + | `PATCH /auth-files/fields` with the priority 10 lower or higher, kept between 0 and 1000. The stepper shows the current value between the buttons, and for a few seconds after a save it tints the value green and floats "✓ saved" over the stepper. | Sets a value. |
| **Make primary** | Sets the priority to the highest other priority plus 10, and enables the account if it is disabled. | On an account that already outranks the others it shows as a quiet **Primary** label instead of a button. A repeat writes nothing. |
| **Clear cooldown** | CPA `POST /reset-quota`. This changes CPA's local scheduler only. | Repeats are safe. Only an account with a cooldown to clear shows it. |
| **Refresh token** | CPA `POST /auth-files/refresh` | The response holds tokens. `cpa.ts` keeps only `ok`. |
| Routing **fill-first** or **round-robin** | `PUT /routing/strategy` | Sets a value. |
| **↻ Read now**, **↻ Read all** | Moves the account's next Anthropic read to now. | Allowed once per 60 s per account. Never allowed during a rate-limit backoff, or once the account has had 8 reads in the last 15 minutes. The card then shows when the next read is allowed. |
| **+ Add account** | Opens Anthropic's OAuth page in a new tab. The server polls CPA until the new account appears. | One flow at a time. A flow expires after 5 minutes. |

**Claim…** is the only accent-colored button. **Disable** has a red outline, and **Enable** on a disabled account is filled. Every button shows a spinner while its action runs, a check when it succeeds, and the server's message when it fails. On a card, the check floats over the top edge of the button area, so it never moves a button. A CPA mutation answers only after the server has re-read CPA, so the card already shows the new state when the spinner stops.

## HTTP API

The UI polls `GET /api/snapshot` every 2 s and again right after each action. Then it runs `deriveDeck(snapshot, now)` from `src/shared/derive.ts` once a second, so countdowns and ages stay live between polls. The server calls the same functions to pick the read mode and to decide whether a claim is allowed.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/` | The UI, bundled in memory at startup |
| GET | `/api/snapshot` | `Snapshot` from `src/shared/domain.ts`: facts only, one writer per part |
| GET | `/api/history?range=24h\|7d\|30d` | `HistoryView`: UTC-hour rows per account and model, per-model totals, and recent errors |
| POST | `/api/act` | Body `{kind, input}` for one row of `ACTIONS` in `src/shared/actions.ts`. Returns the row's output or `{error: {code, message}}`. |

Every route rejects a `Host` other than `127.0.0.1:1338` or `localhost:1338` with 421. Every POST also needs `X-Headroom: 1` and `Content-Type: application/json`. A cross-origin page can't send either header without a preflight, and the server answers no preflight and sends no CORS headers. An `Origin` header, when present, must match the page.

For example, to read which accounts have a claimable weekly reset:

```sh
curl -s 127.0.0.1:1338/api/snapshot | jq '.feeds | map_values(.juniper.last.value.available)'
```

## What it never does

`test/boundaries.test.ts` fails the build if the source breaks one of these rules.

- It never consumes CPA's usage queue, and it never writes to keeper's DB. keeper is opened `mode=ro` with `query_only`.
- It never sends a management request without the key, and it never sends the key anywhere but CPA. Requests go to CPA one at a time, so a wrong key meets one 401 and the requests behind it fail without sending. The 401 or 403 records the key's hash in `var/state.json`, and that key is not tried again for 35 minutes. Each distinct key costs at most one strike per ban window, across restarts, which keeps Headroom under CPA's 5-strike IP ban. A changed key is tried at once.
- It never forwards token material.
- It never calls Anthropic more than once per 10 s overall, and never reads one account's usage more than 8 times in 15 minutes, whatever asked for the read. A 429 backs off that account for its `retry-after`, or else for 5, 10, 20, then 30 minutes. `var/state.json` keeps each account's recent usage reads and its backoff, so a restart loop reads no more often than one long-lived process and the backoff keeps climbing.
