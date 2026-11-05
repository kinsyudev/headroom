# Upstream contract

This file lists every external surface the app reads or writes. Facts here come from CLIProxyAPI v7.3.15 source, cpa-usage-keeper v1.15.7 source, Claude Code 2.1.311's bundle, and live calls made on 2026-11-04. Sanitized live payloads are in `test/fixtures/`, and you regenerate them with `scripts/capture-fixtures.sh`.

## Local environment

| Thing | Value |
| --- | --- |
| CLIProxyAPI (CPA) | `http://127.0.0.1:8317`, brew service `cliproxyapi`, config `~/.cli-proxy-api/config.yaml`, auth dir `~/.cli-proxy-api/` |
| Management key | Plaintext in `/opt/homebrew/etc/cpa-usage-keeper.env` as `CPA_MANAGEMENT_KEY=`. The CPA config only holds its bcrypt hash. |
| cpa-usage-keeper | `http://127.0.0.1:1337`, brew service, SQLite at `/opt/homebrew/var/cpa-usage-keeper/app.db` (WAL) |
| Accounts | 3 Claude OAuth auth files: one personal Max 20x, two on a Team org (Max 5x tier) |
| Routing | `fill-first`, session affinity on. The highest `priority` tier that is available gets all traffic. |

## CPA management API

Base `http://127.0.0.1:8317/v0/management`. Send `Authorization: Bearer <plaintext key>` on every call.

**Lockout hazard.** 5 failed authentications from one IP ban that IP for 30 minutes. A missing key counts as a failure. A ban on 127.0.0.1 also locks out keeper. Validate the key once at startup and never send a request without it.

### GET /auth-files

Fixture: `cpa-auth-files.json`. One entry per credential. The fields that matter:

- Identity: `auth_index` (stable hex id, the join key everywhere), `name` (file name, needed for PATCH), `email`, `provider` (`claude`), `account_type` (`oauth`).
- Routing state: `disabled`, `priority` (int, higher wins), `status` (`active|error|disabled|pending|refreshing|unknown`), `status_message` (raw upstream error JSON string), `unavailable`, `next_retry_after` (RFC3339, only present when in the future).
- `cooldowns[]`: `{scope: credential|model, model_key?, reason, retry_at, remaining_seconds, backoff_level?, http_status?}`. `reason` is one of `quota|credential_quota|unauthorized|payment_required|not_found|invalid_grant|cloudflare_challenge|model_not_supported|transient_error|unknown`.
- `quota`: `{observed_at, signals}` is the passive snapshot of the last real response's `Anthropic-Ratelimit-Unified-*` headers. It is in memory, refreshed only by real traffic, and lost on CPA restart. Values are strings. `*-Utilization` is a 0..1 fraction, `*-Reset` is epoch seconds, and `*-Status` is `allowed|allowed_warning|rejected`. Keys seen: `5h-*`, `7d-*`, `Overage-*`, `Representative-Claim`, `Fallback-Percentage`, `Upgrade-Paths`, `Retry-After`.
- `model_quotas`: per-model copies of the same signals.
- `recent_requests`: 20 buckets of 10 minutes `{time: "HH:MM-HH:MM", success, failed}`. `success` and `failed` are counters since CPA start.
- `last_refresh`: last OAuth token refresh.

### Actions

| Action | Request | Response |
| --- | --- | --- |
| Enable/disable | `PATCH /auth-files/status` `{"name": "<file>", "disabled": true}` | `{"status":"ok","disabled":true}` |
| Set priority | `PATCH /auth-files/fields` `{"name": "<file>", "priority": 10}` | `{"status":"ok"}`. `0` removes it. |
| Clear CPA cooldown | `POST /reset-quota` `{"auth_index": "<idx>"}` | `{"status":"ok","auth_index","models":[...]}`. Local scheduler only, never contacts Anthropic. |
| Force token refresh | `POST /auth-files/refresh` `{"name": "<file>"}` | `{"ok":true,"auth":{...}}`. **The `auth` object contains access and refresh tokens. Discard it server-side and never forward or log it.** |
| Routing strategy | `GET /routing/strategy` returns `{"strategy":"fill-first"}`. `PUT /routing/strategy` `{"value":"round-robin\|fill-first"}` | `{"status":"ok"}` |
| Add account (OAuth) | `GET /anthropic-auth-url?is_webui=true` returns `{status, url, state}`. Open `url` in a browser, then poll `GET /get-auth-status?state=` every 1-2 s until `{"status":"ok"}` or `{"status":"error","error"}`. | The forwarder on :54545 catches the callback, and the new file appears in `/auth-files`. The waiter times out after 5 minutes. |
| Delete | `DELETE /auth-files?name=<file>` | Destructive. Out of scope for v1. |

### POST /api-call

This is the generic upstream proxy. CPA substitutes the account's OAuth token for `$TOKEN$` in header values and in `data`. It never refreshes Claude tokens first.

```json
{"auth_index": "<idx>", "method": "GET", "url": "https://api.anthropic.com/...",
 "header": {"Authorization": "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
            "User-Agent": "claude-cli/2.1.311 (external, cli)", "x-app": "cli"},
 "data": "<string body, optional>"}
```

The response is always HTTP 200 when the call was made: `{"status_code": 200, "header": {...}, "body": "<string>"}`. Read `status_code`, not the HTTP status.

**The `User-Agent` and `x-app` headers are required.** Without them, Anthropic reports every reset program as `ineligible_reason: "surface"`.

## Anthropic OAuth endpoints (via api-call)

**Rate limit.** `/api/oauth/usage` (plain or with query params) is rate-limited per account. About 12 calls per account in 15 minutes (2026-11-04, measured) earned `status_code: 429` with body `{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}` on all three accounts at once. The exact window is unknown. Poll each account at most once every few minutes, honor `retry-after` when present, and back off on 429. Profile calls were not limited at the same point.

**Fixture provenance.** `anthropic-usage-N.json` are real 200 bodies. `anthropic-usage-at-wall-N.json` were rebuilt from the plain bodies plus the `juniper_tide` and `cedar_ember` blocks observed live with Claude Code headers. `synthetic-usage-at-wall-claimable.json` is invented to cover the claimable path, because no live account had a reset available.

### GET /api/oauth/usage

Fixtures: `anthropic-usage-N.json`. This is the authoritative quota state.

- `five_hour`, `seven_day`, `seven_day_*`: `{utilization: 0..100 percent, resets_at: RFC3339}` or null.
- `limits[]` is the normalized list and the one to prefer: `{kind: session|weekly_all|weekly_scoped, group: session|weekly, percent: 0..100, severity: normal|warning|critical, resets_at, scope: null | {model: {display_name}}, is_active}`. `is_active` marks the limit currently binding.
- `spend` (extra usage / usage credits): `{used: {amount_minor, currency, exponent}, limit: {...}, percent, severity, enabled, disabled_reason, cap, ...}`.
- `extra_usage`: legacy view of the same, `{is_enabled, monthly_limit, used_credits, utilization, currency, spend_limit_reached}`.
- Many codename keys (`tangelo`, `amber_cistern`, ...) are usually null. Ignore unknown keys.

### GET /api/oauth/usage?at_wall=1&skip_spend=1

Fixtures: `anthropic-usage-at-wall-N.json`. This is the same body without `spend`, plus the two **reset programs**. This is what Claude Code calls when you hit a limit. These are the "available Claude resets".

`juniper_tide` is the weekly session-limit reset. It is null when the account is not in the program.

```json
{"eligible": false, "ineligible_reason": "not_at_wall", "in_experiment": false, "arm": null,
 "available": false, "next_available_at": null, "weekly_resets_at": null, "resets_per_week": 1,
 "event_props": null}
```

The reset is claimable when `eligible && arm == "reset" && available`. When `!available`, `next_available_at` says when the next one unlocks. `ineligible_reason` is one of `tier|tenure|surface|mobile|cli_version|not_at_wall|weekly_limit|no_weekly_limit|other_experiment|extra_usage...|unknown`.

`cedar_ember` is grant-based resets:

```json
{"eligible": false, "ineligible_reason": "no_grant", "at_limit": false, "exhausted": [],
 "grants": [{"id": "...", "label": "...", "resets_total": 3, "resets_left": 2, "starts_at": "...",
             "ends_at": "...", "clears": ["five_hour"], "paused": false, "usable_now": true,
             "use_requires_limit": true, "percent_used": {}, "blocking": [], "type": "session|weekly|full"}],
 "next_grant_id": "...", "weekly_resets_at": "...", "cooldown_until": null, "event_props": {...},
 "paused_held": false}
```

A grant is usable when `eligible && grant.resets_left > 0 && !grant.paused && grant.usable_now`. Claude Code uses `next_grant_id` as the default grant.

### POST /api/organizations/{org_uuid}/reset_rate_limits

This claims a reset. **It is irreversible and consumes a reset.** `org_uuid` comes from `/api/oauth/profile`. Send the same Claude Code headers. The timeout is 25 s.

- juniper_tide body: `{"program": "juniper_tide"}`. Response `{"result": "reset|already_used|not_limited|ineligible|unavailable", "next_available_at", "weekly_resets_at"}`.
- cedar_ember body: `{"program": "cedar_ember", "grant_id": "<id>", "request_id": "<uuid v4, one per user intent>"}`. Response `{"result": "reset|already_used|not_limited|cooldown|ineligible|unavailable", "reason", "resets_left", "cleared": [...], "weekly_resets_at", "cooldown_until"}`.
- HTTP 429 means rate limited, and 401 or 403 means auth error. On `reset` or `not_limited`, follow up with CPA `POST /reset-quota {auth_index}` so CPA stops cooling the account down.

### GET /api/oauth/profile

Fixtures: `anthropic-profile-N.json`.

- `account`: `{email, has_claude_max, has_claude_pro}`.
- `organization`: `{uuid, name, organization_type: claude_max|claude_team|..., rate_limit_tier: default_claude_max_20x|default_claude_max_5x|..., billing_type, subscription_status}`.

This rarely changes, so cache it for hours.

## Keeper SQLite (read-only history)

Open it with `file:/opt/homebrew/var/cpa-usage-keeper/app.db?mode=ro`. Never write. Keeper owns ingestion. It holds the CPA usage stream via `SUBSCRIBE usage`. Do not consume the CPA usage queue yourself, because `LPOP` and `/usage-queue` are destructive and would steal keeper's records.

- `usage_events` has about 150k rows since 2026-09-25 (measured 2026-11-05), one row per request, about 4k a day. Columns: `timestamp` (RFC3339 text with a **`+08:00` offset**, keeper's TZ, not the Mac's, and a fraction of 0 to 6 digits), `auth_index`, `model`, `reasoning_effort`, `failed` (0/1), `status_code`, `latency_ms`, `ttft_ms`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `total_tokens`, `session_id` (a UUID), `endpoint`.
  - **For Claude, `input_tokens` already includes cache reads and cache creation.** Fresh input is `input_tokens - cache_read_tokens - cache_creation_tokens`. Cache reads are about 97% of input.
  - `reasoning_effort` holds `none`, `low`, `medium`, `high`, `xhigh`, `max`, or `''` when the request set none.
  - `status_code` is 200 for 99.7% of rows. The rest are 499 (the client closed the request), 500, 503 and 529, 429, and a few 401, 404, and 400. Every non-200 row has `failed = 1`.
  - Read rows by `id`, never by a timestamp range. A `WHERE` on `julianday(timestamp)` can't use an index and reads the whole table, about 136 ms for 30 days. The fraction length varies, so comparing timestamp text is wrong. Read `julianday(timestamp)` in the select list and compare instants in code.
  - `SELECT MIN(id), MAX(id)` in one statement scans an index. Two scalar subqueries, `(SELECT MIN(id) …)` and `(SELECT MAX(id) …)`, each do one lookup.
- `error_events` holds 429s and 5xx with `auth_index`, `status_code`, `body`, `auth_quota_reason` (`credential_quota` on a 429), and `auth_quota_next_recover_at`. It has rows only since 2026-11-04. A 429's event is written at the response, a fraction of a second after the request's `usage_events` timestamp.
- Schema: `test/fixtures/keeper-schema.sql`.
- Keeper has no model prices configured, so there is no cost data.
