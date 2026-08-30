# NEO Agent

AI coding assistant — like opencode, powered by **DeepSeek V4 Pro** with a **1M-token context window** (free). Full permissions: reads/writes/edits files, runs bash, searches, builds and verifies projects. Runs as a terminal TUI **or** a web UI.

**Made with ♥ by صاصا (Mostafa)** — [@Mostafa_Desha1](https://github.com/Mostafa_Desha1). Open-source code is for everyone, but respect the creator — don't copy, rebrand, or claim it as your own. Credit where credit is due.

## Install — copy the WHOLE line as one line

```bash
curl -fsSL https://tinyurl.com/26gl3kx9 | sh
```

Short link (no line wrap, works everywhere): `https://tinyurl.com/26gl3kx9` → the latest `install.sh`.

The installer:
- Draws a colored **NEO** banner in a box with a background
- Detects the platform: **Termux (Android) · Linux (Ubuntu / Debian / Fedora / Arch / Alpine) · macOS**
- Checks every required tool one by one (`curl`/`wget`, `tar`, `git`, `node`, `npm`) with a live ✓/✗ spinner
- Offers to auto-install Node.js when it's missing (using `pkg` / `apt` / `dnf` / `pacman` / `apk` / `brew`)
- Installs into `~/.local/share/neo` and creates the `neo` command (in `~/.local/bin`, or **`$PREFIX/bin` on Termux** so it works immediately), verifies `neo --version`, and prints "Type neo to start 🚀"

Without the short link, the raw one-liner (keep it on one line):

```bash
curl -fsSL https://raw.githubusercontent.com/vghhhhhhhhh65-ship-it/neo/main/install.sh | sh
```

Alternative: `git clone https://github.com/vghhhhhhhhh65-ship-it/neo.git && cd neo && npm install && node bin/neo.js`

Then:

```bash
neo            # start the terminal UI (first run: /apikey)
```

> Requires Node.js (Termux on Android: `pkg install nodejs-lts`).

## Terminal UI (recommended)

```bash
neo                          # interactive chat
neo run "build me a calculator"   # one prompt, print the reply
neo web                      # web UI on :3000
neo web --hostname 0.0.0.0   # expose on the network (like opencode)
```

In the TUI you get:
- Live orange `⠇ Thinking…` spinner while the model reasons, separate **think** box
- Live tool cards (📖 read · ✍️ write · ⚡ bash · ✓ done) and inline diffs
- Clean replies — no stray `*`/`#` markdown junk
- `/` command palette (`/help  /clear  /info  /setup  /apikey  /theme  /update  /exit`)
- **Auto-update**: NEO checks for a newer release at launch (and every 45 min). When one exists it downloads it, applies it automatically, and restarts itself into the new version — your chat session, key and config in `~/.neo` are kept. `/update` forces an instant check + upgrade. Run `NEO_DISABLE_UPDATE=1 neo` to turn auto-update off.
- **In-app scrolling** — PgUp/PgDn and the mouse wheel scroll the history; the log is never wiped because the app runs on its own (alt) screen
- Smart context window: long sessions are auto-compacted into a summary note
- Themes (dracula default) — `/theme`
- Works with your mouse wheel and ctrl+p, ctrl+c, ESC-to-stop

## Config

Everything lives in `~/.neo/config.json` (auto-created). Set your API key with `/apikey` or `/setup`, or before startup:

| Flag | Env | Default |
|------|-----|---------|
| `--model <id>` | `MODEL` | deepseek/deepseek-v4-pro |
| `--key <key>` | `API_KEY` | (set via `/apikey`) |
| `--workdir <dir>` | `WORKDIR` | /home |
| `--port <n>` / `--hostname <h>` | `PORT`/`HOSTNAME` | 3000 / 0.0.0.0 (web) |

Config formats: `config.json`, `config.jsonc`, or `config.toml` in `~/.neo/`.

Example `~/.neo/config.json`:

```json
{
  "apiKey": "sk-xt-…",
  "mode": "build",
  "theme": "dracula",
  "model": "deepseek/deepseek-v4-pro"
}
```

## Tools

`list_dir` · `read_file` · `write_file` · `edit_file` · `glob` · `grep` · `bash` (all auto-approved in build mode)

## Files

```
bin/neo.js        CLI entry (neo | neo run | neo web)
core.js           agent loop + tools + model API (shared)
config.js         ~/.neo/config handling (json / jsonc / toml)
server.js         web server
update.js         auto-updater (check GitHub, swap, self-restart)
terminal/         TUI engine (cli, ansi palettes + wide-width, input/keys+mouse, markdown)
public/           web frontend (light theme, token counters, think box)
install.sh        the one-line installer
```

## Uninstall

```bash
rm -rf ~/.local/share/neo ~/.local/bin/neo ~/.neo
```

That's it. Two files, no global state besides `~/.neo` for your key and sessions.