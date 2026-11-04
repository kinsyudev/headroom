#!/usr/bin/env bash
# Captures live CPA + Anthropic payloads into test/fixtures, with emails, UUIDs,
# names and local paths replaced so the fixtures are safe to commit.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/test/fixtures"
ENV_FILE=${KEEPER_ENV:-/opt/homebrew/etc/cpa-usage-keeper.env}
CPA=${CPA_BASE_URL:-http://127.0.0.1:8317}
KEEPER_DB=${KEEPER_DB:-/opt/homebrew/var/cpa-usage-keeper/app.db}
KEY=$(sed -n 's/^CPA_MANAGEMENT_KEY=//p' "$ENV_FILE")
[ -n "$KEY" ] || { echo "CPA_MANAGEMENT_KEY missing in $ENV_FILE" >&2; exit 1; }
mkdir -p "$OUT"

mgmt() { curl -sf -H "Authorization: Bearer $KEY" "$CPA/v0/management/$1"; }

api_call() {
  jq -n --arg idx "$1" --arg url "https://api.anthropic.com$2" '{
    auth_index: $idx, method: "GET", url: $url,
    header: {
      "Authorization": "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.311 (external, cli)",
      "x-app": "cli"
    }}' |
    curl -sf -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
      "$CPA/v0/management/api-call" -d @-
}

# Anthropic rate-limits /api/oauth/usage hard (about a dozen calls per account in
# 15 minutes earned a 429), so a failed call keeps the existing fixture.
capture() {
  local idx=$1 path=$2 file=$3 clean=$4 envelope status
  envelope=$(api_call "$idx" "$path")
  status=$(jq -r '.status_code' <<<"$envelope")
  if [ "$status" != 200 ]; then
    echo "kept $file: upstream status $status $(jq -r '.body' <<<"$envelope" | head -c 120)" >&2
    return 0
  fi
  jq -r '.body' <<<"$envelope" | jq . | $clean > "$OUT/$file"
}

# Emails and UUIDs map to stable distinct placeholders (same input, same output
# across files) so fixtures still tell accounts and orgs apart.
EMAILS=$(mgmt auth-files | jq -r '[.files[].email // empty] | unique | join(" ")')
sanitize() {
  HOME_DIR="$HOME" EMAILS="$EMAILS" perl -MDigest::MD5=md5_hex -pe '
    BEGIN { my $i = 0; @known = split / /, $ENV{EMAILS}; %e = map { $_ => "account" . ++$i . "\@example.com" } @known; }
    for my $k (sort { length($b) <=> length($a) } @known) { s/\Q$k\E/$e{$k}/g; }
    s/(?<![\w.+-])[A-Za-z0-9._%+-]+@(?!example\.com)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(com|ai|dev|io|net|org)\b/other\@example.com/g;
    s/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/"00000000-0000-4000-8000-" . substr(md5_hex($1), 0, 12)/ge;
    s/\Q$ENV{HOME_DIR}\E/\/home\/user/g;
  '
}

sanitize_profile() {
  sanitize | jq '.account.full_name = "Example User" | .account.display_name = "Example" | .organization.name = "Example Org"'
}

main() {
  mgmt auth-files | jq . | sanitize > "$OUT/cpa-auth-files.json"
  mgmt routing/strategy > "$OUT/cpa-routing-strategy.json"

  local n=0 idx
  for idx in $(mgmt auth-files | jq -r '.files[] | select(.provider=="claude") | .auth_index'); do
    n=$((n + 1))
    capture "$idx" '/api/oauth/usage' "anthropic-usage-$n.json" sanitize
    capture "$idx" '/api/oauth/usage?at_wall=1&skip_spend=1' "anthropic-usage-at-wall-$n.json" sanitize
    capture "$idx" '/api/oauth/profile' "anthropic-profile-$n.json" sanitize_profile
    echo "$idx" > "$OUT/auth-index-$n.txt"
  done

  sqlite3 -readonly "file:$KEEPER_DB?mode=ro" '.schema usage_events' '.schema error_events' '.schema usage_identities' > "$OUT/keeper-schema.sql"
  echo "captured $n claude accounts into $OUT"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main; fi
