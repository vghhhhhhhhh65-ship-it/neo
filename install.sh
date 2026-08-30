#!/bin/sh
# NEO Agent — one-command installer.
#   curl -fsSL https://raw.githubusercontent.com/vghhhhhhhhh65-ship-it/neo/main/install.sh | sh
set -e

REPO="vghhhhhhhhh65-ship-it/neo"
APP_DIR="$HOME/.local/share/neo"
BIN_DIR="$HOME/.local/bin"

# Termux on Android keeps $HOME/bin on PATH by default
if [ -d /data/data/com.termux ]; then
  BIN_DIR="$HOME/bin"
fi

command -v node >/dev/null 2>&1 || { echo "✗ Node.js not found — install it first (Termux: pkg install nodejs)"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "✗ npm not found — install it first"; exit 1; }

mkdir -p "$APP_DIR" "$BIN_DIR"

echo "[1/4] Downloading NEO…"
curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" -o /tmp/neo-app.tar.gz

echo "[2/4] Installing to $APP_DIR …"
rm -rf /tmp/neo-main "$APP_DIR"
mkdir -p "$APP_DIR"
tar -xzf /tmp/neo-app.tar.gz -C /tmp
cp -r /tmp/neo-main/. "$APP_DIR"/
rm -rf /tmp/neo-main /tmp/neo-app.tar.gz

echo "[3/4] Installing dependencies…"
( cd "$APP_DIR" && npm install --no-audit --no-fund --silent )

echo "[4/4] Creating the 'neo' launcher…"
cat > "$BIN_DIR/neo" <<EOF
#!/bin/sh
exec node "$APP_DIR/bin/neo.js" "\$@"
EOF
chmod +x "$BIN_DIR/neo"

echo ""
echo "  ✓ NEO installed"
echo ""
echo "  Run it with:   neo"
echo "  (in Termux the command appears after closing/reopening the app,"
echo "   or use:  export PATH=\$HOME/bin:\$PATH)"
echo ""
echo "  First run → set your API key with  /apikey   or   /setup"
echo "  Help:  neo  then  /help   ·   web UI:  neo web"