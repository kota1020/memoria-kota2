#!/bin/bash
# memoria kota2 — 常駐インストール（誰の環境でも動くようにHOMEを埋めて生成）
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
PLIST="$HOME/Library/LaunchAgents/com.memoria.kota2.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/state"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.memoria.kota2</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$DIR/daemon.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/state/launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/launchd.err</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "installed: $PLIST"

# read API（読）— 外部アプリ/エージェントが理解を問い合わせる常駐サービス
API_PLIST="$HOME/Library/LaunchAgents/com.memoria.kota2.api.plist"
API_PORT="${MEMORIA2_API_PORT:-4319}"
cat > "$API_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.memoria.kota2.api</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$DIR/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>MEMORIA2_API_PORT</key><string>$API_PORT</string>${MEMORIA2_API_TOKEN:+
    <key>MEMORIA2_API_TOKEN</key><string>$MEMORIA2_API_TOKEN</string>}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/state/api.log</string>
  <key>StandardErrorPath</key><string>$DIR/state/api.err</string>
</dict></plist>
EOF
launchctl unload "$API_PLIST" 2>/dev/null || true
launchctl load "$API_PLIST"
echo "installed: $API_PLIST  (read API on 127.0.0.1:$API_PORT)"
