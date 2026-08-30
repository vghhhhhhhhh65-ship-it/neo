#!/bin/sh
# ┌─────────────────────────────────────────────┐
# │  NEO · AI coding agent · smart installer    │
# └─────────────────────────────────────────────┘
# One line (copy it whole):
#   curl -fsSL https://tinyurl.com/22etoj4f | sh

set -u

REPO_SLUG="vghhhhhhhhh65-ship-it/neo"
RAW_DIST="https://github.com/$REPO_SLUG/archive/refs/heads/main.tar.gz"

ESC=$(printf '\033')
R0="${ESC}[0m"; BD="${ESC}[1m"; DI="${ESC}[2m"
RR="${ESC}[31m"; GG="${ESC}[32m"; YY="${ESC}[33m"; CC="${ESC}[36m"
BRR="${ESC}[1;31m"; BGG="${ESC}[1;32m"; BYY="${ESC}[1;33m"; BCC="${ESC}[1;36m"; BPP="${ESC}[1;35m"
BOXA="${ESC}[48;2;30;32;45m"          # box background (dark indigo)

if [ -t 1 ]; then TTY=1; else TTY=0; fi

EQ=""; i=0
while [ "$i" -lt 29 ]; do i=$((i + 1)); EQ="$EQ═"; done
DASH=""; i=0
while [ "$i" -lt 29 ]; do i=$((i + 1)); DASH="$DASH─"; done

box_top() { printf '%s%s╔%s╗%s\n' "$BOXA" "$BCC$BD" "$EQ" "$R0"; }
box_ln()  { printf '%s%s║%s%s%s║%s\n' "$BOXA" "$BCC$BD" "$2" "$1" "$BCC$BD" "$R0"; }
box_end() { printf '%s%s╚%s╝%s\n' "$BOXA" "$BCC$BD" "$EQ" "$R0"; }

banner() {
  box_top
  box_ln "███╗   ██╗ ███████╗  ██████╗ " "$BPP"
  box_ln "████╗  ██║ ██╔════╝ ██╔═══██╗" "$BPP"
  box_ln "██╔██╗ ██║ █████╗   ██║   ██║" "$BCC"
  box_ln "██║╚██╗██║ ██╔══╝   ██║   ██║" "$BCC"
  box_ln "██║ ╚████║ ███████╗ ╚██████╔╝" "$BGG"
  box_ln "╚═╝  ╚═══╝ ╚══════╝  ╚═════╝ " "$BGG"
  box_ln "$DASH" "$DI"
  box_ln "★ NEO · DEEPSEEK V4 · 1M CTX " "$BYY"
  box_end
}

step() { printf '\n  %s▸%s %s%s%s   %s%s%s\n' "$BCC" "$R0" "$BD" "$1" "$R0" "$DI" "$2" "$R0"; }

microsleep() { sleep 0.06 2>/dev/null || return 0; }

spin() {
  i=0
  while [ "$i" -lt "$1" ]; do
    i=$((i + 1))
    case $((i % 4)) in
      0) f="-" ;;
      1) f="\\" ;;
      2) f="|" ;;
      3) f="/" ;;
    esac
    printf '\r   %s::%s %sscanning%s %-14s   ' "$DI" "$f" "$DI" "$R0" "${2:-}"
    microsleep
  done
  printf '%s[K\r' "$ESC"
}

# probe <label> <binary> <version-cmd> <troubleshoot-line>
probe() {
  label="$1"; bin="$2"; vercmd="$3"; hint="$4"
  if [ "$TTY" = 1 ]; then
    printf '   %s·%s %s%-18s%s ' "$DI" "$R0" "$DI" "$label" "$R0"
    spin 14 "$label"
  else
    printf '   %s·%s %s%-18s' "$DI" "$R0" "$label" ""
  fi
  if command -v "$bin" >/dev/null 2>&1; then
    v=""
    if [ -n "$vercmd" ]; then
      v="$($vercmd 2>/dev/null | head -1)"
      v=$(printf '%s' "$v" | awk '{print substr($0,1,20)}')
    fi
    printf '\r   %s✓ %s%s' "$GG" "$GG" "$label"
    printf '%-19s %s%s%s\n' "" "$DI" "$v" "$R0"
    return 0
  fi
  printf '\r   %s✗ %s%s' "$RR" "$RR" "$label"
  printf '%-19s  %sMISSING%s\n' "" "$BRR" "$R0"
  printf '        %s%s%s\n' "$DI" "$hint" "$R0"
  return 1
}

detect_platform() {
  PLATFORM="unknown"; PKGCMD=""
  if [ -d /data/data/com.termux ]; then
    PLATFORM="Termux (Android)"; PKGCMD="pkg install -y nodejs-lts"
  elif [ "$(uname -s)" = "Darwin" ]; then
    PLATFORM="macOS"; PKGCMD="brew install node"
  elif [ "$(uname -s)" = "Linux" ]; then
    ID=""; NAME=""
    if [ -r /etc/os-release ]; then . /etc/os-release; fi
    ID="${ID:-}"; NAME="${NAME:-}"
    PLATFORM="Linux${NAME:+ / $NAME}"
    case "$ID" in
      debian|ubuntu) PKGCMD="sudo apt-get update && sudo apt-get install -y nodejs npm" ;;
      fedora|rhel|centos|rocky) PKGCMD="sudo dnf install -y nodejs npm" ;;
      arch|manjaro) PKGCMD="sudo pacman -S --noconfirm nodejs npm" ;;
      alpine) PKGCMD="sudo apk add nodejs npm" ;;
    esac
  fi
  step "Environment" "$PLATFORM  ·  supported: Termux / Linux / macOS"
}

INSTALL_DIR="${NEO_DIR:-$HOME/.local/share/neo}"
BIN_DIR="$HOME/.local/bin"
if [ -d /data/data/com.termux ]; then
  if [ -w "${PREFIX:-/data/data/com.termux/files/usr}/bin" ]; then
    BIN_DIR="${PREFIX:-/data/data/com.termux/files/usr}/bin"
  else
    BIN_DIR="$HOME/bin"
  fi
fi
STAGE="$HOME/.neo-install-stg"
mkdir -p "$BIN_DIR" "$INSTALL_DIR" 2>/dev/null || true

banner
printf '  %sNEO%s  %s·%s  AI coding agent  ·  opencode-style TUI  ·  DeepSeek V4 Pro  ·  1M context\n' "$BYY" "$R0" "$DI" "$R0"

detect_platform

step "Checking required tools" "scanning your system"
MISSING=""
probe "curl / wget" "curl" "curl --version" "Install curl or wget first" || probe "wget" "wget" "wget --version" "Install curl or wget first" || MISSING="downloader"
probe "tar" "tar" "tar --version" "Install tar first" || MISSING="$MISSING tar"
probe "git (tools)" "git" "git --version" "Optional — skip if unavailable"
probe "node" "node" "node -v" "Node.js is required"
probe "npm" "npm" "npm -v" "npm is required"

if [ -n "$MISSING" ]; then
  printf '\n  %s✗ Missing core tools — install them, then run again.%s\n' "$BRR" "$R0"
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '\n  %s✗ Node.js / npm are not installed.%s\n' "$BRR" "$R0"
  if [ -n "$PKGCMD" ]; then
    if [ -t 0 ]; then
      printf '  Install them now automatically?  %s[Y/n]%s  ' "$YY" "$R0"
      read -r ANS
      case "$ANS" in
        y|Y|yes|"")
          printf '  %s→%s %s\n' "$CC" "$R0" "$PKGCMD"
          sh -c "$PKGCMD" || { printf '\n  %s✗ Auto-install failed.%s\n' "$BRR" "$R0"; exit 1; }
          ;;
        *) exit 1 ;;
      esac
    else
      printf '  Run this yourself, then re-run the installer:\n\n    %s%s%s\n\n' "$BYY" "$PKGCMD" "$R0"
      exit 1
    fi
  else
    printf '  Install Node.js from %snodejs.org%s, then re-run this installer.\n' "$BCC" "$R0"
    exit 1
  fi
fi

DL="$STAGE/neo-app.tar.gz"
rm -rf "$STAGE"
mkdir -p "$STAGE"

step "Downloading neo" "GitHub → $HOME"
if command -v curl >/dev/null 2>&1; then
  if [ "$TTY" = 1 ]; then
    curl -fSL --retry 2 --progress-bar "$RAW_DIST" -o "$DL"
  else
    curl -fsSL --retry 2 "$RAW_DIST" -o "$DL"
  fi
else
  wget -q -O "$DL" "$RAW_DIST"
fi

if [ ! -s "$DL" ]; then
  printf '  %s✗ Download failed — check your internet connection.%s\n' "$BRR" "$R0"
  rm -rf "$STAGE"
  exit 1
fi
if tar -tzf "$DL" >/dev/null 2>&1; then
  SIZE=$(ls -lh "$DL" 2>/dev/null | awk '{print $5}')
  printf '  %s✓ package ok  %s%s%s\n' "$GG" "$DI" "$SIZE" "$R0"
else
  printf '  %s✗ Package looks corrupted — try again.%s\n' "$BRR" "$R0"
  rm -rf "$STAGE"
  exit 1
fi

step "Installing" "$INSTALL_DIR"
tar -xzf "$DL" -C "$STAGE"
SRC="$STAGE/neo-main"
if [ ! -d "$SRC" ]; then SRC=$(ls -d "$STAGE"/* 2>/dev/null | head -1); fi
if [ -n "$SRC" ] && [ -d "$SRC" ]; then cp -r "$SRC"/. "$INSTALL_DIR"/; fi
if [ ! -f "$INSTALL_DIR/bin/neo.js" ]; then
  printf '  %s✗ Installation incomplete.%s\n' "$BRR" "$R0"
  rm -rf "$STAGE"
  exit 1
fi
printf '  %s✓ copied to %s%s%s\n' "$GG" "$DI" "$INSTALL_DIR" "$R0"

step "Dependencies" "npm install"
( cd "$INSTALL_DIR" && npm install --no-audit --no-fund --silent ) 2>/dev/null
if [ -d "$INSTALL_DIR/node_modules/express" ]; then
  printf '  %s✓ dependencies ready.%s\n' "$GG" "$R0"
else
  printf '  %s! npm install failed — the TUI still works, web UI won’t.%s\n' "$YY" "$R0"
fi

step "Creating the command" "$BIN_DIR/neo"
cat > "$BIN_DIR/neo" <<EOF
#!/bin/sh
exec node "$INSTALL_DIR/bin/neo.js" "\$@"
EOF
chmod +x "$BIN_DIR/neo"
printf '  %s✓ launcher ready.%s\n' "$GG" "$R0"

step "Testing" "neo --version"
VERSION=""
if [ -x "$BIN_DIR/neo" ]; then VERSION=$("$BIN_DIR/neo" --version 2>/dev/null); fi
if [ -n "${VERSION:-}" ]; then
  printf '  %s✓ installed version: %s%s%s\n' "$GG" "$BGG" "$VERSION" "$R0"
else
  printf '  %s! test failed — try: %s%s --help%s\n' "$YY" "$R0" "$BYY" "$BIN_DIR/neo" "$R0"
fi

ON_PATH=0
case ":$PATH:" in *":$BIN_DIR:") ON_PATH=1 ;; esac
if [ "$ON_PATH" = 0 ]; then
  printf '\n  %s! %s is not on your PATH.%s\n' "$YY" "$BIN_DIR" "$R0"
  printf '      Add it once:\n'
  printf '        %sexport PATH="%s:$PATH"%s\n' "$CC" "$BIN_DIR" "$R0"
  if [ -d /data/data/com.termux ]; then
    printf '      On Termux, close & reopen the app so the PATH entry takes effect.\n'
  else
    printf '      Or (with permissions):  %ssudo ln -sf %s/neo /usr/local/bin/neo%s\n' "$CC" "$BIN_DIR" "$R0"
  fi
fi

rm -rf "$STAGE"
printf '\n'
box_top
box_ln "✔  INSTALLED SUCCESSFULLY    " "$BGG"
box_ln "$DASH" "$DI"
box_ln "▸  Type  neo  to start  🚀   " "$BYY"
box_end
printf '\n'
printf '  First run → type  %s/apikey%s  inside neo to set your API key\n' "$BYY" "$R0"
printf '  Commands: /help  /clear  /setup  /theme  /exit   ·   scroll: PgUp/PgDn / mouse wheel\n'
printf '  Remove:   %srm -rf ~/.local/share/neo%s  +  %s%s%s\n' "$BYY" "$R0" "$BYY" "$BIN_DIR/neo" "$R0"
printf '\n'
printf '  %s★%s Made with %s♥%s by %sصاصا (Mostafa)%s  ·  %s@Mostafa_Desha1%s\n' "$YY" "$R0" "$RR" "$R0" "$BYY" "$R0" "$BCC" "$R0"
printf '\n'