#!/bin/sh
# ███╗   ██╗███████╗ ██████╗   — smart installer
# One line (copy it whole):
#   curl -fsSL https://raw.githubusercontent.com/vghhhhhhhhh65-ship-it/neo/main/install.sh | sh

set -u

REPO_SLUG="vghhhhhhhhh65-ship-it/neo"
RAW_DIST="https://github.com/$REPO_SLUG/archive/refs/heads/main.tar.gz"

ESC=$(printf '\033')
RESET="${ESC}[0m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
RED="${ESC}[31m"
GREEN="${ESC}[32m"
YELLOW="${ESC}[33m"
PURPLE="${ESC}[35m"
CYAN="${ESC}[36m"
RED_B="${ESC}[1;31m"
GREEN_B="${ESC}[1;32m"
YELLOW_B="${ESC}[1;33m"
CYAN_B="${ESC}[1;36m"

if [ -t 1 ]; then TTY=1; else TTY=0; fi

print_banner() {
  printf '%s█████▄ ██▄██ ██████  ██████%s\n' "$PURPLE" "$RESET"
  printf '%s██▄▄██ ██▀██ ██      ██▄▄  %s\n' "$CYAN" "$RESET"
  printf '%s█████▀ ██ ▀██ ██████  ██████%s\n' "$YELLOW" "$RESET"
}

step() {
  printf '\n  %s▸%s %s%s%s   %s%s%s\n' "$CYAN_B" "$RESET" "$BOLD" "$1" "$RESET" "$DIM" "$2" "$RESET"
}

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
    printf '\r   %s::%s %s%s%s      ' "$DIM" "$f" "$DIM" "${2:-}" "$RESET"
    microsleep
  done
  printf '%s[K' "$ESC"
  printf '\r'
}

# probe <label> <command> <version-cmd> <missing-hint>   → found: 0 / missing: 1
probe() {
  label="$1"; bin="$2"; vercmd="$3"; hint="$4"
  if [ "$TTY" = 1 ]; then
    printf '   %s·%s %s%-20s%s ' "$DIM" "$RESET" "$DIM" "$label" "$RESET"
    spin 14
  else
    printf '   %s…%s %s%-20s' "$DIM" "$RESET" "$label"
  fi
  if command -v "$bin" >/dev/null 2>&1; then
    v=""
    if [ -n "$vercmd" ]; then v="$($vercmd 2>/dev/null | head -1)"; fi
    printf '\r   %s✓%s %s%-20s%s  %s%s%s\n' "$GREEN" "$RESET" "$GREEN" "$label" "$RESET" "$DIM" "$v" "$RESET"
    return 0
  fi
  printf '\r   %s✗%s %s%-20s%s  %smissing%s\n' "$RED" "$RESET" "$RED" "$label" "$RESET" "$RED_B" "$RESET"
  printf '     %s%s%s\n' "$DIM" "$hint" "$RESET"
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
    PLATFORM="Linux${NAME:+ — $NAME}"
    case "$ID" in
      debian|ubuntu) PKGCMD="sudo apt-get update && sudo apt-get install -y nodejs npm" ;;
      fedora|rhel|centos|rocky) PKGCMD="sudo dnf install -y nodejs npm" ;;
      arch|manjaro) PKGCMD="sudo pacman -S --noconfirm nodejs npm" ;;
      alpine) PKGCMD="sudo apk add nodejs npm" ;;
    esac
  fi
  step "بيئة التشغيل" "$PLATFORM (مدعوم: Termux · Linux · macOS)"
}

INSTALL_DIR="${NEO_DIR:-$HOME/.local/share/neo}"
BIN_DIR="$HOME/.local/bin"
if [ -d /data/data/com.termux ]; then BIN_DIR="$HOME/bin"; fi
mkdir -p "$BIN_DIR" 2>/dev/null || true

print_banner
printf '  %s★%s %sNEO%s · AI coding agent · %sDeepSeek V4 Pro%s · %s1M context%s\n\n' \
  "$YELLOW" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET" "$BOLD" "$RESET"

detect_platform

step "فحص المتطلبات" "checking required tools"
MISSING=""
probe "curl" "curl" "curl --version" "تحتاج curl — أو wget" || probe "wget" "wget" "wget --version" "تحتاج curl أو wget" || MISSING="downloader"
probe "tar" "tar" "tar --version" "تحتاج tar" || MISSING=" tar"
probe "git (أدوات)" "git" "git --version" "(اختياري)"
probe "node" "node" "node -v" "Node.js مطلوب"
probe "npm" "npm" "npm -v" "npm مطلوب"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '\n  %s✗%s Node.js / npm غير موجودة في هذا النظام.\n' "$RED_B" "$RESET"
  if [ -n "$PKGCMD" ]; then
    if [ -t 0 ]; then
      printf '  هل أثبّتها الآن تلقائياً؟  %s[Y/n]%s  ' "$YELLOW" "$RESET"
      read -r ANS
      case "$ANS" in
        y|Y|yes|"")
          printf '  %s→%s %s\n' "$CYAN" "$RESET" "$PKGCMD"
          sh -c "$PKGCMD" || { printf '  %s✗%s فشل التثبيت.%s\n' "$RED_B" "$RESET"; exit 1; }
          ;;
        *) exit 1 ;;
      esac
    else
      printf '  شغّل هذا الأمر بنفسك ثم أعد تشغيل المثبّت:\n\n    %s%s%s\n\n' "$YELLOW_B" "$PKGCMD" "$RESET"
      exit 1
    fi
  else
    printf '  ثبّت Node.js من %snodejs.org%s وأعد التشغيل.\n' "$CYAN_B" "$RESET"
    exit 1
  fi
fi

if [ -n "$MISSING" ]; then
  printf '  %s✗%s أدوات أساسية ناقصة — ثبّتها ثم أعد التشغيل.%s\n' "$RED_B" "$RESET"
  exit 1
fi

DL="/tmp/neo-install.tar.gz"
rm -f "$DL"

step "تحميل الحزمة" "$RAW_DIST"
printf '  %s…%s جارٍ التنزيل\n' "$DIM" "$RESET"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$RAW_DIST" -o "$DL" 2>"$DL.err" || curl -fsSL "$RAW_DIST" -o "$DL"
else
  wget -q -O "$DL" "$RAW_DIST"
fi
rm -f "$DL.err"
if [ ! -s "$DL" ]; then
  printf '  %s✗%s فشل التحميل — تأكد من الإنترنت.%s\n' "$RED_B" "$RESET"
  exit 1
fi
SIZE=$(ls -lh "$DL" 2>/dev/null | awk '{print $5}')
if tar -tzf "$DL" >/dev/null 2>&1; then
  printf '  %s✓%s الحزمة سليمة  %s(%s)%s\n' "$GREEN" "$RESET" "$DIM" "$SIZE" "$RESET"
else
  printf '  %s✗%s الحزمة تالفة.%s\n' "$RED_B" "$RESET"
  rm -f "$DL"; exit 1
fi

step "التثبيت" "$INSTALL_DIR"
dir="$INSTALL_DIR"
rm -rf "$dir" "$dir.tmp"
mkdir -p "$dir.tmp"
tar -xzf "$DL" -C "$dir.tmp"
SRC="$dir.tmp/neo-main"
if [ ! -d "$SRC" ]; then SRC=$(ls -d "$dir.tmp"/* 2>/dev/null | head -1); fi
if [ -n "$SRC" ] && [ -d "$SRC" ]; then cp -r "$SRC"/. "$dir"/; fi
rm -rf "$dir.tmp" "$DL"
if [ ! -f "$dir/bin/neo.js" ]; then
  printf '  %s✗%s الحزمة غير مكتملة.%s\n' "$RED_B" "$RESET"; exit 1
fi
printf '  %s✓%s تم النسخ.\n' "$GREEN" "$RESET"

step "المكتبات (npm install)" "express + web UI"
( cd "$dir" && npm install --no-audit --no-fund --silent ) 2>/dev/null
if [ -d "$dir/node_modules/express" ]; then
  printf '  %s✓%s التبعيات جاهزة.\n' "$GREEN" "$RESET"
else
  printf '  %s!%s npm install تعثّر — TUI سيعمل رغم ذلك.%s\n' "$YELLOW" "$RESET"
fi

step "إنشاء الأمر neo" "$BIN_DIR/neo"
cat > "$BIN_DIR/neo" <<EOF
#!/bin/sh
exec node "$dir/bin/neo.js" "\$@"
EOF
chmod +x "$BIN_DIR/neo"
printf '  %s✓%s launcher جاهز.\n' "$GREEN" "$RESET"

step "فحص التشغيل" "neo --version"
if [ -x "$BIN_DIR/neo" ]; then
  VERSION=$("$BIN_DIR/neo" --version 2>/dev/null)
fi
if [ -n "${VERSION:-}" ]; then
  printf '  %s✓%s الإصدار المثبّت: %s%s%s\n' "$GREEN" "$RESET" "$GREEN_B" "$VERSION" "$RESET"
else
  printf '  %s!%s اختبره يدوياً: %s%s %s--help%s\n' "$YELLOW" "$RESET" "$YELLOW_B" "$BIN_DIR/neo" "$RESET" "$YELLOW_B"
fi

ON_PATH=0
case ":$PATH:" in *":$BIN_DIR:") ON_PATH=1 ;; esac
if [ "$ON_PATH" = 0 ]; then
  printf '\n  %s!%s %s غير موجودة في PATH.\n' "$YELLOW" "$RESET" "$BIN_DIR"
  printf '      أضفها مرة واحدة:\n'
  printf '        %sexport PATH="%s:$PATH"%s\n' "$CYAN" "$BIN_DIR" "$RESET"
  printf '      أو بصلاحيات:  %ssudo ln -sf %s/neo /usr/local/bin/neo%s\n' "$CYAN" "$BIN_DIR" "$RESET"
fi

printf '\n  %s══════════════════════════════════════════════════════%s\n' "$CYAN_B" "$RESET"
printf '  %s✓%s  %sتم التثبيت بنجاح%s  %s✔%s\n' "$CYAN_B" "$RESET" "$GREEN_B" "$RESET" "$YELLOW" "$RESET"
printf '  %s▸%s   %sاكتب  neo  للتشغيل 🚀%s\n' "$CYAN_B" "$RESET" "$YELLOW_B" "$RESET"
printf '  %s══════════════════════════════════════════════════════%s\n' "$CYAN_B" "$RESET"
printf '\n'
printf '  أول مرة:  اكتب  %s/apikey%s  لضبط مفتاح API\n' "$YELLOW_B" "$RESET"
printf '  أوامر:     /help   /clear   /setup   /theme   /exit\n'
printf '  تمرير:     PgUp / PgDn  أو عجلة الفأرة\n'
printf '  إلغاء:     %srm -rf ~/.local/share/neo%s  +  %s%s%s\n' "$YELLOW_B" "$RESET" "$YELLOW_B" "$BIN_DIR/neo" "$RESET"
printf '\n'