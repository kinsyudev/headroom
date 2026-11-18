#!/bin/sh
set -eu

LABEL=dev.headroom
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/headroom"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/headroom.log"
DOMAIN="gui/$(id -u)"

stop_agent() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  i=0
  while [ "$i" -lt 5 ] && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; do
    sleep 1
    i=$((i + 1))
  done
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

env_entry() {
  name=$1
  eval "value=\${$name:-}"
  [ -n "$value" ] || return 0
  printf '    <key>%s</key><string>%s</string>\n' "$name" "$(xml_escape "$value")"
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_agent
  rm -f "$PLIST" "$BIN"
  echo "Removed $LABEL and $BIN. State in ~/Library/Application Support/Headroom and the log in $LOG are left in place."
  exit 0
fi

[ "$#" -eq 0 ] || { echo "usage: install.sh [--uninstall]" >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
[ -f "$here/headroom" ] || { echo "headroom binary not found next to install.sh" >&2; exit 1; }

stop_agent

mkdir -p "$BIN_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp "$here/headroom" "$BIN.new"
chmod 755 "$BIN.new"
mv -f "$BIN.new" "$BIN"
xattr -d com.apple.quarantine "$BIN" >/dev/null 2>&1 || true

ENV_ENTRIES=$(env_entry CPA_BASE_URL; env_entry HEADROOM_ENV_FILE; env_entry HEADROOM_KEEPER_DB; env_entry HEADROOM_PORT)

cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BIN")</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$HOME/.local/bin"):/opt/homebrew/bin:/usr/bin:/bin</string>
$ENV_ENTRIES
  </dict>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null || { echo "generated plist is invalid: $PLIST" >&2; exit 1; }

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $BIN. Headroom is starting on http://127.0.0.1:${HEADROOM_PORT:-1338}. Log: $LOG"
