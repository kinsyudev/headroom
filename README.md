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

The header ends with one status line. It reads "Live · updated 3s ago" while CPA, the routing strategy and the history log are all fresh. When one of them is aging, stale or failing, the line names that source in color instead, for example "History not updated for 6m" or "CPA not answering". Hover it for each source's age and what it feeds. When CPA stops answering, the dot beside the title turns red and that line reads "CPA not answering". One banner under the header says so, gives one time phrase ("CPA last answered at 04:14 (16s ago)"), says the quota, resets and history below are the last known values, and says to check that CPA is running. Every button that calls CPA is disabled until it answers. While CPA is not answering, an amber line across the top of the overview strip reads "Last known values · CPA last answered 04:14", and the row controls (**Make primary**, the priority stepper, **Check now**, **Refresh token**, **Disable**, **Clear cooldown** and **Claim…**) keep their shape and dim in place, with a not-allowed cursor and the reason in their tooltip.

The overview strip comes first. It has four tiles. Under each tile's figure, an account is named by its color swatch and the part of its email before the @, and hovering the name shows the whole email.

- **Serving now** headlines the account with the newest successful request in the last 2 minutes, from keeper's request log. When keeper can't be read, CPA's response headers stand in, and the tile's tooltip and a banner say so. The line under it gives the age of that request and either "also takes the next new session" or the account a new session would land on instead. Any other account that answered in the window is named on a last line. While CPA is not answering, the age gives way to the clock time of the request, so it does not read as live.
- **Next reset** counts down to the earliest window reset, and to the earliest moment a blocked account routes again. When the account that resets first also unblocks within a minute of it, the line under the countdown leads with the red **■ Blocked** chip the accounts table uses, for example "■ Blocked account3 · session limit · unblocks 06:07". Otherwise that line names the account and the window that resets, and a blocked account that unblocks at another time gets a second line led by the same chip, for example "■ Blocked account2 · unblocks 14:50". With no account blocked, no chip shows.
- **Claimable resets** lists every reset Anthropic says you can claim now, grouped under its account. Each reset is named by what it does and where it comes from, for example "Reset session limit · weekly" or "Reset session limit · bonus" with how many bonus resets are left beside it, and has its own **Claim…**. The account card and the claim dialog use the same names. While CPA is not answering, the tile says claims are paused and does not link to the accounts.
- **Room left** counts the enabled accounts that are open, for example "2 of 3 accounts open". An open account is one CPA can send a request to now, neither blocked nor at a limit. Under the count, one line for each of the first two open accounts, in the order traffic reaches them, names its role and the session and weekly room its row shows, for example "serving account1 · 88% session · 73% weekly" and "next account2 · 100% session · 99% weekly". The serving accounts come first, newest request first, then the rest by priority, so "next" is the account a new session would land on. An open account with no limits read yet reads "not read yet".

Below 1010 px of window width the tiles sit in two columns and each is as tall as its content. Serving now sits over Next reset on the left, and Claimable resets over Room left on the right.

Each account card is as tall as its content. Cards sit three across from 1180 px of window width, two across from 860 px, and one below that. Each card shows these parts:

- The routing role (serving, standby, blocked with a countdown, or disabled) and the plan.
- One panel when the account is in trouble or has a reset to act on. It opens with the cause and when it ends, for example "Session limit reached · account and 3 models cooling down until the session resets at 03:25 (in 1h 52m)", or "Monthly spend limit hit · account cooling down until 22:15" when the cooldown does not end with a reset. The cause is CPA's message where it maps to a known phrase, and the cooldown reason otherwise. **Details** and **Clear cooldown** follow the cause. **Details** opens the per-model list with CPA's reason codes and its full message. Under the cause, a "Resets you can claim" block lists both reset programs, the fixes. Each row leads with what sets it apart, for example "Weekly reset · clears the session limit" or "Bonus reset · 2 of 3 left · ends Nov 30 13:05", and a claimable one has its **Claim…** right after the text. A reset that is not claimable shows its state there instead, such as "Next at Thu 09:00 (in 6d)". With more than one bonus, each bonus gets its own line with its name and what it clears. When no reset is claimable, waiting, in flight or unreadable and nothing is wrong, the row has no panel.
- One status line with the age of the freshest successful usage check and when the next check is due, for example "checked 22s ago · next check in 4m 38s", followed by **↻ Check now**. When the account is at its limit and not blocked, an "At limit" badge starts the line, and Headroom checks reset programs every 3 minutes. Otherwise it checks usage every 5 minutes. A feed that is aging, stale or failing shows in color on the line, for example "limits read failing · retry in 2m". While CPA is not answering, "checks paused" stands where the next check would be. A feed held by design, such as the weekly reset away from the limit, is not on the line. Hover the line for every feed's age, last error and next read, held feeds included, and, when there is no reset panel, for why, such as "Resets you can claim: none · weekly reset offered at limit · no bonus resets".
- One row per window with the meter, what is left ("88%", under a column header that says "Session left", and in the row label "Session left" where the headers are hidden), a "limiting" tag on the window that holds the account back (Anthropic's active window, once it is at warning or critical), and the reset as the countdown then the clock time, for example "4h 32m · 23:00". Hover the reset for "resets 23:00 · in 4h 32m". Each row shows the newer of the poll and the passive headers. Hover the row for both readings and their ages, where the other one reads "Second reading: live 17% left, 52s ago". A window whose reset has passed reads "14:20 ✓ · awaiting data" instead of its old reading. A missing session limit reads "100%" and "starts on first request". A meter with more than half left is drawn in a softer grey so the windows running low stand out, and a window at its limit tints its track red and outlines it thinly in red. A bar is always as long as what is left, so a window with nothing left is an empty track. In a card narrower than 340 px the countdown and the clock time stack on two lines.
- Extra usage, which wall reads skip. While the account is at its limit only the header view of overage is current. The row says what to expect. A meter with "$88 of $100 left" is a cap with room. A cap spent to its limit or past it reads "Cap used" with a red ✕ over an empty red meter, and "$100.62 of $100" (spent of cap) under it. Its tooltip says the monthly cap is used up and extra-usage requests are rejected until it resets, with a time only when the headers gave one. A whole amount drops its cents. In the wide layout the amounts sit under the meter and wrap rather than clip. "Off" covers both a disabled extra usage and an enabled one with a $0.00 cap, and its tooltip says requests stop at the plan limits. When Anthropic rejects extra usage the row says so with the reason, for example "monthly spend cap reached · extra-usage requests are rejected", and adds "resets" with a time only when the headers gave one. Hover the row for what is left, the reason code and the age of each reading.
- CPA's last 20 ten-minute buckets of traffic.

The history panel shows stacked columns per account for 24 hours, 7 days, or 30 days, in your local time. The last column is the hour (or day) still running, so it is striped, labelled "now", and its tooltip says "in progress". A tooltip lists only the accounts with something in that column, plus the total. The **Chart | Table** switch at the right end of the panel header swaps the columns for a table. Below the chart are totals per model and keeper's newest 50 errors and rate limits for these accounts. At every width the per-model table shows the **Usage** columns (requests, failed, rate-limited and output), and the **Cache and latency** switch above it swaps in the uncached input, cache read, cache write, latency and first-token columns. A table that is still wider than the panel scrolls sideways and fades the edge that has more.

## What you can do

| Control | Effect | Safety |
| --- | --- | --- |
| **Claim…** | Opens a dialog that names the account, the reset type (its raw program code is in the name's tooltip), the bonus, the effect, when the limit would reset on its own without the claim, and the age of the data behind the offer. On confirm, the server reads fresh reset data, refuses unless the offer is still claimable, then sends `reset_rate_limits` once. On `reset` or `not_limited` it calls CPA `reset-quota` up to 3 times. | Irreversible. A second click while a claim is in flight gets the same result. After a claim ends, the program stays held until a read taken at least a minute later shows the outcome, and the server refuses another claim for it until then. A timeout shows "Outcome unknown, checking" for that time, and the claim is never resent. |
| **Enable** or **Disable** | `PATCH /auth-files/status` | Sets a value, so repeats are safe. |
| **Priority** −10 and +10 | `PATCH /auth-files/fields` with the priority 10 lower or higher, kept between 0 and 1000. A caption beside it says which way wins, "higher serves first", or "unused in round-robin" while round-robin routing ignores priority. Hover the label for what priority does. The stepper shows the current value between the buttons, and for a few seconds after a save it tints the value green and floats "✓ saved" over the stepper. | Sets a value. |
| **Make primary** | Sets the priority to the highest other priority plus 10, and enables the account if it is disabled. | On the account fill-first sends new sessions to first, alone at the top of the accounts that can take them, it shows as a "★ Primary" badge, with no button shape, instead of the button. The badge and the button share one fixed-width slot, so the stepper starts at the same place on every card. Its tooltip says to raise another account above it to change that. A repeat writes nothing. |
| **Clear cooldown** | CPA `POST /reset-quota`. This changes CPA's local scheduler only. | Repeats are safe. Only an account with a cooldown to clear shows it. |
| **Refresh token** | CPA `POST /auth-files/refresh` | The response holds tokens. `cpa.ts` keeps only `ok`. |
| Routing **fill-first** or **round-robin** | `PUT /routing/strategy`. Hover either for what it does. | Sets a value. |
| **↻ Check now**, **↻ Check all** | Moves the account's next Anthropic read to now. | Allowed once per 60 s per account. Never allowed during a rate-limit backoff, or once the account has had 8 reads in the last 15 minutes. The row then shows when the next check is allowed. |
| **+ Add account** | Opens Anthropic's OAuth page in a new tab. The server polls CPA until the new account appears. | One flow at a time. A flow expires after 5 minutes. |

**Claim…** is the only accent-colored button. **Check now**, **Refresh token** and **Disable** have no outline until hovered. **Disable** is set in a muted red at rest, a little apart from **Refresh token**, and gains a red fill and outline on hover or keyboard focus. **Enable** on a disabled account is filled. Every button shows a spinner while its action runs, a check when it succeeds, and the server's message when it fails. On a card, the check floats over the top edge of the button area, so it never moves a button. A CPA mutation answers only after the server has re-read CPA, so the card already shows the new state when the spinner stops.

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
