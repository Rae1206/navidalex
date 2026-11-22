# Navidalex

A dark emerald-and-black festive Herdr layout inspired by Persona 5's torn-paper chrome, paired with a full multi-agent chat view (`any-chat`), GPU-cached ASCII festive side rails (`festive-rail`), a semantic red/green Git diff viewer (`file-view` + `changes`), and a productivity side panel.

## What the window looks like

- **Theme (`themes/persona5-forest.json`)**: Deep forest-black canvas (`#030806`), mint-emerald foreground (`#D4F7DE`), crisp green accents (`#5CE08A`), and torn-paper chrome headers with an **Animation On/Off** toggle in the bottom status bar (`p5.motion`).
- **Top bar (`mods/p5-tabs-forest/`)**: Slanted torn-paper tab strip, live clock, quick shortcuts (`Inbox`, `PRs`, `History`), `+ NEW` button, and optional full-window serif title cards (`mods/hero-legend/`) scheduled on the hour from `09:00` to `17:00` plus `11:10` ("Dream."), `12:27` ("Go eat."), and `17:25` ("Run.") when Animation is On.
- **Left sidebar (`mods/p5-chrome-forest/`, `p5-spaces-forest/`, `p5-agents-forest/`, `pi-agents/`)**: Collapsible rail with Spaces, Persona-style cat portrait agent cards (`HP`/`SP` gauges and live status), and a subagent tracker (`pi-agents`).
- **Center workspace (`views` stack — toggle with `Ctrl+Shift+J`)**:
  - **Chat view (`mods/any-chat/`)**: Agent-neutral chat supporting **Claude Code, Pi, Codex, and OpenCode** with:
    - Direct clipboard image paste (`Ctrl+V`) and drag-and-drop (`on_drop`) into a visual thumbnail tray (`pi-images/`), plus inline clickable thumbnails in bubbles.
    - `@` mention fuzzy popup for recent images (with thumbnails) and project files, plus `/` slash autocomplete for both Claude and Pi.
    - `↑` / `↓` composer prompt history and persistent per-agent drafts (`localStorage`).
    - Unified live `Model · Thinking` button for Pi (`mods/pi-models/`).
    - Interactive question/choice cards for Claude (`AskUserQuestion`) and Pi (`ask_user_choice`, `ask_user_question`, `plan_mode_question`).
    - Inline Git red/green diffs for both Claude and Pi `edit`/`write` calls, clickable `file:line` links into `file-view`, in-chat search (`Ctrl+F`), hover message actions (`Copy`, `Quote`, `Reuse`), live context bar + `$` cost, and `↑ Previous` / `↓ Next` turn navigation.
  - **Festive side rails (`mods/festive-rail/`)**: Flanking the narrow chat column on wide windows — GPU-cached transparent PNG sprites pre-rendered from `Consolas` ASCII art (twin Christmas trees with 9 twinkling light/glint banks and ribboned gifts, plus a glowing ASCII full moon at top-right), falling snow, heart & Clawd fireworks, and a patrolling cat that reflects the active agent's status. All motion respects the `Animation` toggle (`p5.motion`) and automatically pauses while typing.
  - **Terminal view (`mods/p5-pane-chat-forest/`)**: Native Herdr terminals with a matching Terminal/Chat slide switch in the header.
- **Right side panel (`panel-tabs` stack)**: Auto-opening side panel with `file-view` (full-file Git diff with unmistakable `#3FB950` green additions and `#F85149` red deletions, `Only changes`/`Full file` toggle, `file:line` selection, Markdown & raster image preview), `files`, `changes` (matching Git red/green diff), `needs-inbox`, `recap`, `odd-tasks`, `ci-board`, `blueprint`, `agenttrail`, `git-graph`, plus `skillshare` and `redline` / `session-history` / `atuin-threads` overlays.
- **Bottom status bar (`mods/p5-status-forest/`)**: Active machine, agent count, `ON/OFF ANIMATION` toggle, and command palette button.

## Included files

```text
navidalex/
├── RECIPE.md
├── preview.png
├── layouts/navidalex.json
├── themes/persona5-forest.json
├── keys.json
├── assets/                    # Forest title sprite, wallpaper, and cat portraits
├── mods/                      # All custom/modified mods and icon assets used by the layout
└── extensions/
    └── herdr-chat-session.js  # Optional Pi extension for live session isolation, commands, models & contextWindow
```

## How to install (for an agent)

1. Copy `layouts/navidalex.json` into `~/.config/herdr-app/layouts/navidalex.json`.
2. Copy `themes/persona5-forest.json` into `~/.config/herdr-app/themes/persona5-forest.json`.
3. Copy `assets/*` into `~/.config/herdr-app/assets/`.
4. Copy every folder inside `mods/` into `~/.config/herdr-app/mods/` (do not overwrite unrelated user mods; inspect before replacing `changes` if customized).
5. Merge the bindings from `keys.json` into the user's existing `~/.config/herdr-app/keys.json` without clobbering their own shortcuts.
6. *(Optional, for Pi users)* Copy `extensions/herdr-chat-session.js` into `~/.pi/agent/extensions/herdr-chat-session.js` and run `/reload` in Pi so `any-chat` receives live Pi commands, model/thinking control, and `contextWindow` metadata.
7. Run `herdr-app check` on copied mods, then switch with `herdr-app do layout.switch '{"name":"navidalex"}'`.

## Assumptions & Notes

- Tested on **Windows** (`herdr-app` v0.1.16+ / `hc` v0.1.21+). Clipboard image paste in `any-chat` and `pi-images` uses PowerShell + `.NET` `System.Windows.Forms`/`System.Drawing`; drag-and-drop and inline image rendering work cross-platform via GPUI `image()` staged under `~/.config/herdr-app/`.
- Shipped Herdr built-in mods (`workspace-chrome`, `files`, `pane`, `tabs`, etc.) are expected to come from the user's Herdr installation and are not duplicated here.
- Semantic Git diff colors (`#3FB950` green / `#F85149` red) are defined explicitly in `file-view`, `changes`, and `any-chat` so deleted lines remain unmistakably red despite the monochrome green ANSI palette of `persona5-forest`.

## Credits

- Chrome and Persona-style layout foundations adapted from [FunnyQ/herdr-layout-p5](https://github.com/FunnyQ/herdr-layout-p5).
- Multi-agent chat foundations adapted from [mysteriousHerb/herdr-zoo](https://github.com/mysteriousHerb/herdr-zoo) (`claude-chat`, MIT).
