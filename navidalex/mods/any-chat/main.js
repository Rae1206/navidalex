// any-chat: herdr-zoo's claude-chat (mysteriousHerb/herdr-zoo, MIT) made agent-neutral.
// Claude Code works exactly as in claude-chat; Pi, Codex and OpenCode are found and read by
// ./agents.js and drawn with the same chat (messages, tool rows, composer, search, Stop).
// Claude-only: the / menu, model / effort dropdowns, question cards, fork and sub-agent cards.
// Claude Code as a chat. Shows one Claude agent's conversation, read from Claude's own transcript
// (~/.claude/projects/<folder>/<session>.jsonl), and types what you write into its terminal.
// The terminal stays the real Claude: when it asks something (a permission), the bottom of its
// screen shows here with buttons that press its keys. props: { terminal } (else the shown tab's
// Claude agent). A dev container's Claude (docker exec ... claude) is read through docker.

import { View, div, svg, image } from "gpui-kit";

// Native cached islands (navidalex-native fork): a marked subtree is reused while it is
// unchanged. Older Herdr builds have no .island(); they draw it inline as before.
const ISLAND = typeof div().island === "function";
const island = (el) => (ISLAND ? el.island() : el);
import { v_flex, h_flex, TextView, TextareaState, Textarea, InputState, Input, Popover } from "gpui-base";
import { readFile, readdir, exists, writeFile } from "fs/promises";
import os from "os";
import { Buffer } from "buffer";
import { agents, terminals, panes, spaces, focused, props, layout, hc, exec, home, run, theme, settings, watchFolder, shared, setShared, openOverlay, appHome, readTextFile, writeTextFile, nextCommand, checking, closeOverlay } from "herdr";
import COMMANDS from "./commands.js";
import { openAgentControls } from "./controls.js";
import * as ask from "./question.js";
import { NAMES, kindOf, findSession, runtimeMetadata, ingestLines, opencodeStamp, opencodeItems } from "./agents.js";
import { newUsage, trackUsage, contextOf, readPlan, planWindows, usesClaudePlan, tokens, until } from "./usage.js";
import { PromptHistory, DraftStore } from "./history.js";
import { extractImagePaths, stageImageFile, cacheBase64Image, stageDroppedPaths, listRecentImages, captureClipboardImages } from "./images.js";
import { mentionAt, matchMentions, applyMention, scanProjectFiles } from "./mentions.js";

function openPiPicker(agent) {
  return openOverlay({ mod: "pi-models", kind: "popup", width: 620, height: 0.75, props: { terminal: agent.address } });
}

function piModelButtonLabel(piMeta, fallbackModel) {
  const ctl = piMeta?.control;
  const rawId = ctl?.model?.id ?? (fallbackModel ? String(fallbackModel).split("/").pop() : "");
  const shortModel = rawId ? (rawId.length > 22 ? `${rawId.slice(0, 21)}…` : rawId) : "";
  const thinking = ctl?.thinking && ctl.thinking !== "off" ? ctl.thinking : "";
  if (shortModel && thinking) return `${shortModel} · ${thinking}`;
  if (shortModel) return shortModel;
  return "Model";
}

const sameMention = (a, b) => Boolean(a && b) && a.start === b.start && a.query === b.query;

const CLAUDE = `${home()}/.claude`;
// The chat's look, shared by every copy and kept across restarts; the ⚙ popup changes it.
// size: the message text in px (the rest scales with it); font: "ui" or "mono" (the terminals');
// width: "full" or "narrow" (a readable column); tools: "show" or "hide" the tool-call rows;
// accent: a key of ACCENTS; mine (your messages): "box", "tint" or "bar"; bg: the theme color
// behind the messages, or a "#rrggbb"; fg: the text color, "theme" or a "#rrggbb";
// space: "tight", "normal" or "roomy" between them.
const LOOK = "chat.look";
const TYPING_SHARED_KEY = "chat.festiveTyping";
const TYPING_IDLE_MS = 300;
const TYPING_LEASE_MS = 8000;
// history: earlier turns "fold" (one row each) or "show".
const LOOK_DEFAULT = { size: 16, font: "ui", width: "narrow", tools: "show", history: "fold", accent: "theme", mine: "box", bg: "background", fg: "theme", space: "normal" };
const HEX = /^#[0-9a-f]{6}$/i;
// Ready-made picks beside the hex boxes: dark and light backgrounds, and text for either.
const BGS = { "#0d1117": "Night", "#1e1e1e": "Charcoal", "#22201c": "Coffee", "#f6f1e7": "Paper", "#ffffff": "White" };
const FGS = { "#e6edf3": "Soft white", "#c9d1d9": "Gray", "#f0dfbf": "Cream", "#24292f": "Ink", "#000000": "Black" };
const chatLook = () => ({ ...LOOK_DEFAULT, ...(shared(LOOK) ?? {}) });
const setLook = (change) => {
  setShared(LOOK, { ...chatLook(), ...change });
  if ("fg" in change) syncForeground();
};
// Message text is Herdr's TextView, which only ever takes the theme's foreground, so a chosen
// text color goes into settings.json's colors.foreground: the whole app's text (the user's choice,
// 2026-10-31). "theme" removes it. writeTextFile refuses if the file changed since it was read.
async function syncForeground() {
  const fg = chatLook().fg;
  const path = `${appHome()}/settings.json`;
  for (let tries = 0; tries < 2; tries++) {
    const text = await readTextFile(path);
    const s = JSON.parse(text ?? "{}");
    const now = s.colors?.foreground;
    if (HEX.test(fg) ? now === fg : now === undefined) return;
    const colors = { ...(s.colors ?? {}) };
    if (HEX.test(fg)) colors.foreground = fg;
    else delete colors.foreground;
    if (Object.keys(colors).length) s.colors = colors;
    else delete s.colors;
    try {
      await writeTextFile(path, JSON.stringify(s, null, 2) + "\n", text);
      return;
    } catch {}
  }
}
syncForeground();
// "Claude (dev container)" in the + menu (`my-new-menu`), switched in the ⚙ popup: on = this
// computer's programs.json has the entry, so that file is the setting. On by default (the user's
// choice 2026-11-02; the space's folder must hold the .devcontainer, the standard VS Code layout): the first run
// on Windows (the command is cmd.exe) adds it, once; shared `chat.devContainer` remembers that a
// choice was made, so Off sticks. Turning it on leaves an entry edited by hand alone; off removes
// it. Herdr reloads programs.json live.
const DEV_KEY = "claude-dev-container";
const DEV_ENTRY = { name: "Claude (dev container)", icon: "icons/claude.svg", tint: false,
  run: ["cmd.exe", "/c", "devcontainer up --workspace-folder . && devcontainer exec --workspace-folder . claude"] };
// The entry as it was until 2026-11-07 (a harness-agent checkout beside the space's folder,
// which only worked because the space's folder was itself named harness-agent): an entry
// still exactly like it is moved to the new one, once; an edited one is left alone.
const OLD_RUN = ["cmd.exe", "/c", "devcontainer up --workspace-folder ..\\harness-agent && devcontainer exec --workspace-folder ..\\harness-agent claude"];
const programsPath = () => `${appHome()}/programs.json`;
async function devContainerOn() {
  return Boolean(JSON.parse((await readTextFile(programsPath())) ?? "{}").programs?.[DEV_KEY]);
}
async function setDevContainer(on) {
  for (let tries = 0; tries < 2; tries++) {
    const text = await readTextFile(programsPath());
    const p = JSON.parse(text ?? "{}");
    const programs = { ...(p.programs ?? {}) };
    const stale = on && JSON.stringify(programs[DEV_KEY]?.run) === JSON.stringify(OLD_RUN);
    if (Boolean(programs[DEV_KEY]) === on && !stale) return;
    if (on) programs[DEV_KEY] = DEV_ENTRY;
    else delete programs[DEV_KEY];
    if (Object.keys(programs).length) p.programs = programs;
    else delete p.programs;
    try {
      await writeTextFile(programsPath(), JSON.stringify(p, null, 2) + "\n", text);
      return;
    } catch (e) { if (tries) throw e; }
  }
}
const DEV_CHOICE = "chat.devContainer";
if (shared(DEV_CHOICE) == null && /^win/.test(os.platform())) {
  // Local change: no dev container here, so the + menu entry starts off (the chat ⚙ can still turn it on).
  setShared(DEV_CHOICE, false);
} else if (shared(DEV_CHOICE) === true) {
  setDevContainer(true).catch(() => {}); // moves an OLD_RUN entry to the new one
}
// null = the theme's own accent.
const ACCENTS = { theme: null, claude: "#d97757", blue: "#4f8cff", green: "#3fb950", purple: "#a371f7", pink: "#f778ba" };
const GAPS = { tight: 8, normal: 14, roomy: 20 };
// Message text line height (a multiplier) and the accent per agent when the theme's is used.
const LINE = 1.55;
const THINK_SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Claude's own live line on its screen while it works: "✻ Cogitating… (1m 2s · ↓ 12k tokens)".
const LIVE_LINE = /^\s*[✻✶✳✢✽✺·*●◐◓◑◒]\s+([A-Z][\w-]*…[^\n]{0,120})$/;
const AGENT_ACCENTS = { claude: "#d97757", pi: "#3fb950", codex: "#4f8cff", opencode: "#a371f7" };
const SPEAKERS = { claude: "Claude", pi: "Pi", codex: "Codex", opencode: "OpenCode" };
// Layouts drawn in the Forest/Alex green-and-black theme; shared("layout") names the shown layout.
const FOREST_LAYOUTS = new Set(["p5-forest", "navidalex", "alex"]);
// A saved #rrggbb in the pink-to-red range (clearly chromatic, hue 300..30 degrees): an old Forest pink choice.
const pinkish = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d < 0.08) return false;
  let h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h >= 300 || h < 30;
};
// The theme with the chat's accent and background swapped in. In the Forest/Alex layouts the theme's green is the
// accent unless the saved choice is a non-pink swatch (kept as saved), and a saved pink-to-red background gives the
// theme's background. Other layouts resolve exactly as before.
function chatTheme() {
  const t = theme();
  const look = chatLook();
  const forest = FOREST_LAYOUTS.has(shared("layout"));
  const picked = forest && look.accent === "pink" ? null : ACCENTS[look.accent];
  const accent = picked ?? (forest ? t.accent : AGENT_ACCENTS[chatTheme.kind] ?? t.accent);
  const bg = forest && HEX.test(look.bg) && pinkish(look.bg) ? "background" : look.bg;
  const out = { ...t, accent, background: HEX.test(bg) ? bg : t[bg] ?? t.background };
  // A chosen text color also makes the secondary text: the same color, fainter.
  if (HEX.test(look.fg)) Object.assign(out, { foreground: look.fg, muted: look.fg + "d9", dim: look.fg + "99" });
  return out;
}
// A color at some opacity ("26" = 15%), for 6-digit hex colors.
const fade = (color, alpha) => /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7) + alpha : color;
// A text size from the 13 px design, scaled to the chosen size.
const px = (n) => Math.round((n * chatLook().size) / 13 * 2) / 2;
// The reading column: about 80–90 characters a line at the default size.
const NARROW = 880;
// The transcript's side padding: the column centered in a narrow look, 16 px at least.
// (navidalex draws its festive gutters as mods/festive-rail blocks beside this chat.)
const chatPad = (width, narrow) => (narrow ? Math.max(16, (width - NARROW) / 2) : 16);
// In a layout that puts this chat between two festive-rail blocks (props.block = this chat's
// own block id), the block is the column plus its padding in a narrow look, and takes the
// whole row in a full one (the rails keep a sliver of the same background).
const blockSize = (narrow) => (narrow ? { px: NARROW + 32 } : { weight: 1000 });
// How many messages to draw at first; "Show earlier" adds this many more.
const PAGE = 50;
// One of Claude's own boxes is on its screen while Herdr says idle or done (Ctrl+R's history
// filter, a setup offer like "Teach auto mode about your environment?"): its footer, in the
// screen's last lines.
const BOX_FOOTER = /\b(Esc to (cancel|exit|close|go back)|Enter to (continue|confirm|select|submit))\b/i;
const boxUp = (screen) => BOX_FOOTER.test(screen.replace(/\r/g, "").trim().split("\n").slice(-4).join("\n"));
// How much of a local transcript is decoded and read at a time (see readAfter).
const LOAD_SLICE = 4 * 1024 * 1024;
const MAX_DETAIL = 4000;
// Bytes of a container's transcript per read (exec's output stops at 8 MiB).
const CHUNK = 4000000;
// Commands that, run bare, open a menu or a screen in Claude's terminal (the chat flips to it).
const OPENS = new Set(["add-dir", "agents", "artifacts", "color", "config", "context", "diff", "effort", "export", "help",
  "hooks", "ide", "keybindings", "list-agents", "login", "logout", "mcp", "memory", "mobile", "model", "output-style",
  "permissions", "plugin", "powerup", "radio", "rate-limit-options", "release-notes", "remote-control", "resume",
  "rewind", "skills", "status", "statusline", "tasks", "theme", "tui", "usage", "workflows"]);

// The header's model / effort bar (see pick), as Claude's /model list names them; the alias is
// how settings.json's "model" names the default. Read off Claude 2.1.318, 2026-11-05. The
// version numbers go stale (the list still said "Fable 5.1" on 2.1.322, which runs Fable 5.2),
// so only the family counts: the dropdown shows the running model's own name for its family,
// and a pick takes the family's row in Claude's list, whatever version it says.
const MODELS = [["opus", "Opus 5.5"], ["fable", "Fable 5.2"], ["sonnet", "Sonnet 5.5"], ["haiku", "Haiku 5.5"]];
const family = (label) => String(label ?? "").split(" ")[0];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// "claude-opus-5-5" → "Opus 5.5"; a display name stays as it is.
const modelLabel = (m) => {
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{6,})?$/.exec(m ?? "");
  return id ? `${id[1][0].toUpperCase()}${id[1].slice(1)} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : m || null;
};
const modelId = (label) => label ? `claude-${label.toLowerCase().replace(/[ .]/g, "-")}` : null;

// The box can't say where its caret is, so it's taken from the edit: the end of what changed
// between the two values (where typing or a paste left it).
function caretAfter(was, now) {
  let a = 0;
  while (a < was.length && a < now.length && was[a] === now[a]) a++;
  let b = 0;
  while (b < was.length - a && b < now.length - a && was[was.length - 1 - b] === now[now.length - 1 - b]) b++;
  return now.length - b;
}

// The "/word" the caret is in, if the "/" starts the box or follows a space or line break:
// { text, start (the "/"), end, q (what's after the "/") }, else null.
function slashAt(text, caret) {
  let start = caret;
  while (start > 0 && /[\w:-]/.test(text[start - 1])) start--;
  if (text[start - 1] !== "/") return null;
  start--;
  if (start > 0 && !/\s/.test(text[start - 1])) return null;
  let end = caret;
  while (end < text.length && /[\w:-]/.test(text[end])) end++;
  return { text, start, end, q: text.slice(start + 1, end) };
}

const sameSlash = (a, b) => Boolean(a && b) && a.start === b.start && a.q === b.q;
// The tool that starts a sub-agent ("Task" in older Claude Codes). Its rows are cards that open
// the sub-agent's own conversation, read from <session>/subagents/agent-<id>.jsonl.
const AGENT_TOOLS = new Set(["Agent", "Task"]);
// Shared: how many sub-agents each Claude agent has at work, { "<address>": n }, for my-status.
const SUBS = "chat.subs";
const CONTAINERS = "chat.containers"; // { "<address>": "<container>" }, for my-status
// A sub-agent still at work: its meta doesn't say finished, and a foreground one's call isn't
// answered yet (an interrupted one's meta may never say finished).
const subRunning = (sub, tool) => !sub.finished && (tool?.result === undefined || /^Async agent launched/.test(tool.result));

// Every process by parent: its pid, when it started (ms) and its command line. To find the
// Claude under a terminal's shell.
async function children() {
  const win = /^win/.test(os.platform());
  const r = win
    ? await exec("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), $_.CommandLine }"])
    : await exec("ps", ["-A", "-o", "pid=,ppid=,etimes=,args="]);
  const map = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = win ? /^(\d+)\|(\d+)\|(\d+)\|(.*)/.exec(line.trim()) : /^(\d+)\s+(\d+)\s+(\d+)\s+(.*)/.exec(line.trim());
    if (!m) continue;
    const p = { pid: Number(m[1]), start: win ? Number(m[3]) : Date.now() - Number(m[3]) * 1000, cmd: m[4] };
    map.set(Number(m[2]), [...(map.get(Number(m[2])) ?? []), p]);
  }
  return map;
}

// `docker exec [-u user] [-e CLAUDE_CONFIG_DIR=dir] ... <container> claude`: a dev container's
// Claude, the way the devcontainer CLI starts it. Never show this line: it carries its env.
function dockerExec(cmd) {
  if (!/docker(\.exe)?"?\s+exec\s/i.test(cmd)) return null;
  const m = /\s(\S+)\s+claude(\s|$)/.exec(cmd);
  if (!m) return null;
  return { container: m[1], user: /\s-u\s+(\S+)/.exec(cmd)?.[1] ?? null, dir: /\sCLAUDE_CONFIG_DIR=(\S+)/.exec(cmd)?.[1] ?? "" };
}

// Runs a shell script in the container, as its Claude's user. $1 is Claude's folder there.
function inDocker(where, script, ...args) {
  return exec("docker", ["exec", ...(where.user ? ["-u", where.user] : []), where.container,
    "sh", "-c", `d=\${1:-$HOME/.claude}; ${script}`, "sh", where.dir, ...args]);
}

// The claude args of a `docker exec … claude …` line, for telling execs apart.
const claudeArgs = (cmd) => (/\sclaude(\s.*)?$/.exec(cmd)?.[1] ?? "").replace(/["']/g, "").replace(/\s+/g, " ").trim();

// A container Claude's sessions/<pid>.json, if it is really this process's. The folder can be
// a volume shared by several containers, each running Claudes with the same low pids, so the
// file can be another container's (its `pidDomain` names the writer's pid namespace) or a dead
// process's with the same pid (its `procStart` is the writer's /proc/<pid>/stat start ticks).
// A good one is current: Claude rewrites it on /clear, unlike the tasks file it opened at start.
function ownSession(file, ns, ticks) {
  if (!file?.sessionId) return null;
  if (file.pidDomain && ns && !file.pidDomain.endsWith(ns)) return null;
  if (file.procStart && ticks && String(file.procStart) !== String(ticks)) return null;
  return file;
}

// The container's Claude: among the container's own `claude` processes started by an exec
// (parent pid 0) with the same args as this agent's `docker exec … claude …` (`p`), the one
// that started nearest to when the exec did (normally a second apart). The start is the
// session file's wall-clock `startedAt` when the file is the process's (`ownSession`), else
// from `ps`'s elapsed time, which drifts by hours after the computer slept (the VM's monotonic
// clock stops): on 2026-11-07 that picked a Claude 36 min off over the right one, 3 h off.
async function inContainer(where, p) {
  const args = claudeArgs(p.cmd);
  const r = await inDocker(where, 'now=$(date +%s); ps -eo pid=,ppid=,etimes=,args= | while read pid ppid et cmd; do [ "$ppid" = 0 ] && case "$cmd" in claude|"claude "*) echo "P $pid $((now-et)) $(awk "{print \\$22}" /proc/$pid/stat 2>/dev/null) $(readlink /proc/$pid/ns/pid 2>/dev/null) $cmd"; echo "F $(cat "$d/sessions/$pid.json" 2>/dev/null | tr -d "\\n")";; esac; done; true');
  const lines = r.stdout.split("\n");
  const claudes = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^P (\d+) (\d+) (\d*) (\S*) claude(.*)$/.exec(lines[i].trim());
    if (!m) continue;
    let file = null;
    try { file = lines[i + 1]?.startsWith("F ") ? ownSession(JSON.parse(lines[i + 1].slice(2)), m[4], m[3]) : null; } catch {}
    claudes.push({ pid: Number(m[1]), start: file?.startedAt ?? Number(m[2]) * 1000, args: claudeArgs(` claude${m[5]}`) });
  }
  const best = claudes.filter((c) => c.args === args)
    .sort((a, b) => Math.abs(a.start - p.start) - Math.abs(b.start - p.start) || b.pid - a.pid)[0];
  return best ? { ...where, pid: best.pid } : null;
}

// Where the Claude running in `address` keeps its session: here (~/.claude/sessions/<pid>.json),
// or { container, user, dir, pid } in a dev container.
// `tree` (from children()) can be shared by several lookups: it takes ~2 s on Windows.
async function locate(address, tree = null) {
  const shell = JSON.parse((await hc(["get", address, "--json"])).stdout).pid;
  const known = new Set((await readdir(`${CLAUDE}/sessions`)).filter((f) => f.endsWith(".json")).map((f) => Number(f.slice(0, -5))));
  if (known.has(shell)) return { pid: shell };
  tree ??= await children();
  const queue = [shell];
  while (queue.length) {
    for (const p of tree.get(queue.shift()) ?? []) {
      if (known.has(p.pid)) return { pid: p.pid };
      const docker = dockerExec(p.cmd);
      if (docker) return inContainer(docker, p);
      queue.push(p.pid);
    }
  }
  return null;
}

const folderName = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");

// UTF-8 bytes as a string (this runtime's Buffer can't decode, and there's no TextDecoder).
function utf8(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return decodeURIComponent(escape(bin));
}

// A local file's whole lines after byte `pos`, and the byte they end at; text null if the file
// shrank. Read as bytes, decoding only the new part: decoding all of a 10 MB transcript on every
// change took Herdr's UI thread 60–150 ms (the bytes alone take ~25 ms).
// At most `max` bytes at a time (more: there's more after `end`): a 25 MB transcript decoded and
// read in one go ran past Herdr's time limit and the chat stayed empty (2026-10-31).
async function readAfter(file, pos, max = Infinity) {
  const bytes = await readFile(file);
  if (bytes.length < pos) return { text: null, end: 0 };
  const last = bytes.lastIndexOf(10) + 1;
  let end = pos + max < last ? bytes.lastIndexOf(10, pos + max - 1) + 1 : last;
  if (end <= pos) end = last; // one line longer than max
  return end > pos ? { text: utf8(bytes.subarray(pos, end)), end, more: end < last } : { text: "", end: pos };
}

async function transcriptOf(session) {
  const guess = `${CLAUDE}/projects/${folderName(session.cwd)}/${session.sessionId}.jsonl`;
  if (await exists(guess)) return guess;
  for (const dir of await readdir(`${CLAUDE}/projects`)) {
    const file = `${CLAUDE}/projects/${dir}/${session.sessionId}.jsonl`;
    if (await exists(file)) return file;
  }
  return null;
}

// A /resume typed into Claude's own prompt changes its session, but sessions/<pid>.json keeps
// the one from the last /clear (Claude 2.1.306; seen 2026-11-09: a dev-container agent /clear'd,
// then /resume'd its old chat and worked there for a day, while the chat showed the "/clear"-only
// transcript). The file does say when its status last changed (`statusUpdatedAt`): the moment
// a prompt was taken (working) or a turn ended (idle). The session the agent is on has a line
// at that moment: for a prompt, in history.jsonl (each prompt with its session id; cheap), and
// in any case in its transcript (`scan`: the transcripts in that cwd written since, their tails
// searched for a timestamp within 2 s; one shell call, dev containers only). The pick is kept
// on `where` (per agent) until the file's session changes, i.e. the next /clear, and each status
// change is looked at once.
// Dev containers share one Claude folder, so the transcripts scanned include the other
// containers' agents': on 2026-11-10 a Claude just started in one container (no transcript yet)
// showed the chat of one at work in another, which had a line within 2 s of its start. So a
// status that hasn't changed since the start is not looked at (nothing was resumed yet), and
// the sessions the other agents are on (`taken`) never count.
const HISTORY_TAIL = 65536;
async function followResume(where, file, history, scan = null, taken = null) {
  if (where.fileId !== file.sessionId) Object.assign(where, { fileId: file.sessionId, resumed: null });
  const at = file.statusUpdatedAt;
  const fresh = file.status !== "working" && file.startedAt && Math.abs(at - file.startedAt) < 3000;
  if (at && at !== where.matchedAt && !fresh) {
    where.matchedAt = at;
    const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
    let ids = new Set();
    if (file.status === "working") {
      for (const line of ((await history().catch(() => "")) ?? "").split("\n")) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        // A /clear is logged under the session it ended.
        if (e?.sessionId && e.display !== "/clear" && same(e.project, file.cwd) && Math.abs(e.timestamp - at) <= 3000) ids.add(e.sessionId);
      }
    }
    if (ids.size !== 1 && scan) ids = new Set(await scan(at).catch(() => []));
    const theirs = taken?.() ?? new Set();
    for (const id of [...ids]) if (id !== file.sessionId && theirs.has(id)) ids.delete(id);
    // Nothing at that moment, or two Claudes in this cwd at once: keep what we had.
    if (ids.size === 1) {
      const [id] = ids;
      where.resumed = id === file.sessionId ? null : id;
    }
  }
  return where.resumed ? { ...file, sessionId: where.resumed } : file;
}

// The sessions in `folder` (a projects/ folder name) with a transcript line stamped within 2 s
// of `at`, among transcripts written since then (`find -mmin`, so a minute's slack), by their tails.
async function scanTranscripts(where, folder, at) {
  const seconds = [-2, -1, 0, 1, 2].map((s) => new Date(at + s * 1000).toISOString().slice(0, 19)).join("|");
  const mins = String(Math.max(1, Math.ceil((Date.now() - at) / 60000) + 1));
  const r = await inDocker(where, 'for f in $(find "$d/projects/$2" -maxdepth 1 -name "*.jsonl" -mmin -$3 2>/dev/null); do tail -c 200000 "$f" | grep -qE "\\"timestamp\\":\\"($4)" && basename "$f" .jsonl; done; true', folder, mins, seconds);
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/.test(s));
}

// The session a Claude is on now ({ sessionId, cwd, … }): here from its sessions/<pid>.json;
// in a container from that file when it is the process's own (`ownSession`; it is current:
// Claude rewrites it on /clear), else from the process itself: the session id is in the path
// of its open <tmp>/claude-<uid>/<folder>/<session id>/tasks file, the cwd is /proc/<pid>/cwd.
// That file is the one opened at start, so after a /clear it names the old session (seen
// 2026-11-07: the chat showed the old transcript and no question card), hence the file first.
// Neither follows a /resume typed into Claude's own prompt (`followResume`).
async function sessionOf(where, taken = null) {
  if (!where.container) {
    const text = await readFile(`${CLAUDE}/sessions/${where.pid}.json`, "utf8").catch(() => null);
    let file = null;
    try { file = text ? JSON.parse(text) : null; } catch { return null; }
    return file && followResume(where, file, async () => {
      const bytes = await readFile(`${CLAUDE}/history.jsonl`).catch(() => null);
      return bytes ? utf8(bytes.subarray(Math.max(0, bytes.length - HISTORY_TAIL))) : "";
    }, null, taken);
  }
  const r = await inDocker(where, "p=$2; n=$(readlink /proc/$p/ns/pid 2>/dev/null); k=$(awk '{print $22}' /proc/$p/stat 2>/dev/null); s=$(for f in /proc/$p/fd/*; do readlink \"$f\"; done 2>/dev/null | sed -n \"s#^/tmp/claude-[0-9]*/[^/]*/\\([0-9a-f-]\\{36\\}\\)/.*#\\1#p\" | head -n 1); c=$(readlink /proc/$p/cwd 2>/dev/null); printf '{\"ns\":\"%s\",\"ticks\":\"%s\",\"fd\":\"%s\",\"cwd\":\"%s\",\"file\":' \"$n\" \"$k\" \"$s\" \"$c\"; cat \"$d/sessions/$p.json\" 2>/dev/null || echo null; echo \"}\"; echo --history--; tail -c $3 \"$d/history.jsonl\" 2>/dev/null", String(where.pid), String(HISTORY_TAIL));
  const [head, history = ""] = r.stdout.split("--history--\n");
  let j;
  try { j = JSON.parse(head); } catch { return null; }
  const own = ownSession(j?.file, j?.ns, j?.ticks);
  if (own) return followResume(where, own, async () => history, (at) => scanTranscripts(where, folderName(own.cwd), at), taken);
  // No file of its own: the session the process started on, if it has the tasks file (a
  // --resume'd one on 2.1.306 had none), else nothing rather than another container's.
  return j?.fd && j?.cwd ? { sessionId: j.fd, cwd: j.cwd, pid: where.pid } : null;
}

// Its transcript; in a container, relative to its Claude folder (read through docker).
const fileOf = (where, session) => (where.container ? `projects/${folderName(session.cwd)}/${session.sessionId}.jsonl` : transcriptOf(session));

// Plain text as markdown that shows it as typed: punctuation escaped, every line break kept.
const plainEscape = (s) => s.replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, "\\$&");
// Claude's empty prompt while it holds queued messages (a narrow terminal wraps it).
const QUEUE_HINT = { test: (s) => s.replace(/[^a-z]/gi, "") === "Pressuptoeditqueuedmessages" };
// What Claude's prompt holds, read off its screen: the lines between the last two rules, after "❯ ".
function promptText(screen) {
  const lines = screen.split("\n");
  const rules = [];
  lines.forEach((l, i) => { if (/^\s*─{20,}\s*$/.test(l)) rules.push(i); });
  if (rules.length < 2) return "";
  const [a, b] = rules.slice(-2);
  return lines.slice(a + 1, b).map((l) => l.replace(/^\s*❯?\s?/, "")).join("\n").trim();
}

const plainMarkdown = (s) => s.replace(/\r/g, "").split(/\n\s*\n/)
  .map((p) => plainEscape(p).replace(/\n/g, "\\\n")).join("\n\n");
// A random v4 UUID, for a forked session's id.
const newUuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) =>
  (c === "x" ? Math.random() * 16 | 0 : (Math.random() * 4 | 0) + 8).toString(16));
const clip = (s, n = MAX_DETAIL) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const tag = (s, name) => s.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function resultText(content) {
  if (typeof content === "string") return content;
  return (content ?? []).map((b) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : "")).join("\n");
}

// One line about a tool call, like Claude's own "● Bash(...)".
function toolLine(name, input = {}) {
  const base = (p) => p?.split(/[\\/]/).pop();
  const said = input.description ?? base(input.file_path ?? input.path ?? input.filePath ?? input.notebook_path) ?? input.pattern ?? input.url ?? input.query ?? input.command ?? input.prompt;
  if (typeof said === "string") return said.split("\n")[0];
  const first = Object.values(input).find((v) => typeof v === "string");
  return first?.split("\n")[0] ?? "";
}

// Diffs of Edit / Write calls, drawn like Claude's own: line numbers, red and green rows.
// Once the call is answered, its result carries Claude Code's structuredPatch (hunks with
// context lines and real line numbers); until then the call's own old/new text is shown.
const MAX_DIFF = 400;
const diffText = (s) => s.replace(/\r/g, "").replace(/\t/g, "    ");
const diffLines = (s) => (s ? diffText(s).replace(/\n$/, "").split("\n") : []);
function patchRows(hunks) {
  const rows = [];
  hunks.forEach((h, k) => {
    if (k) rows.push({ kind: "gap" });
    let old = h.oldStart, next = h.newStart;
    for (const line of h.lines) {
      const sign = line[0], text = diffText(line.slice(1));
      if (sign === "-") rows.push({ kind: "-", num: old++, text });
      else if (sign === "+") rows.push({ kind: "+", num: next++, text });
      else if (sign === " ") { old++; rows.push({ kind: " ", num: next++, text }); }
    }
  });
  return rows;
}
const swapRows = (before, after) => [...diffLines(before).map((text) => ({ kind: "-", text })), ...diffLines(after).map((text) => ({ kind: "+", text }))];
// The patch, kept to MAX_DIFF lines (the heap note in ingest), with the whole change's counts.
function keepPatch(hunks) {
  let add = 0, del = 0, room = MAX_DIFF, more = 0;
  const kept = [];
  for (const h of hunks) {
    for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
    if (room <= 0) { more += h.lines.length; continue; }
    kept.push({ oldStart: h.oldStart, newStart: h.newStart, lines: h.lines.slice(0, room) });
    more += Math.max(0, h.lines.length - room); room -= h.lines.length;
  }
  return { hunks: kept, add, del, more };
}
function diffOf(item) {
  if (item.diff !== undefined) return item.diff;
  const input = item.input ?? {};
  const filePath = input.file_path ?? input.path ?? input.filePath;
  let rows;
  if (item.patch?.hunks.length) rows = patchRows(item.patch.hunks);
  else if (typeof input.content === "string" && filePath) rows = diffLines(input.content).map((text, i) => ({ kind: "+", num: i + 1, text }));
  else if (typeof input.old_string === "string") rows = swapRows(input.old_string, input.new_string);
  else if (typeof input.oldText === "string") rows = swapRows(input.oldText, input.newText ?? "");
  else if (Array.isArray(input.edits)) {
    rows = input.edits.flatMap((e, k) => [
      ...(k ? [{ kind: "gap" }] : []),
      ...swapRows(e.old_string ?? e.oldText ?? "", e.new_string ?? e.newText ?? ""),
    ]);
  }
  if (!rows) return (item.diff = null);
  const count = (kind) => rows.filter((r) => r.kind === kind).length;
  const more = (item.patch?.more ?? 0) + Math.max(0, rows.length - MAX_DIFF);
  return (item.diff = { path: filePath, rows: rows.slice(0, MAX_DIFF), more,
    add: item.patch?.hunks.length ? item.patch.add : count("+"), del: item.patch?.hunks.length ? item.patch.del : count("-") });
}

function toolDetail(input = {}) {
  const filePath = input.file_path ?? input.path ?? input.filePath ?? "";
  if (typeof input.command === "string") return `$ ${input.command}`;
  if (typeof input.old_string === "string") return `${filePath}\n- ${input.old_string}\n+ ${input.new_string}`;
  if (typeof input.oldText === "string") return `${filePath}\n- ${input.oldText}\n+ ${input.newText ?? ""}`;
  if (typeof input.content === "string") return `${filePath}\n${input.content}`;
  return JSON.stringify(input, null, 2);
}

// What the search looks through in an item: its text, and for a tool call its input and output
// too (a hit there opens the row).
function searchText(item) {
  if (item.kind !== "tool") return item.text ?? "";
  const input = item.input ?? {};
  const head = AGENT_TOOLS.has(item.name) ? `${input.subagent_type ?? ""}\n${input.description ?? ""}\n${input.prompt ?? ""}`
    : ask.isQuestionTool(item.name) ? JSON.stringify(input) : `${item.name}\n${toolLine(item.name, input)}\n${toolDetail(input)}`;
  return `${head}\n${item.result ?? ""}`;
}
// The query as typed, any case.
const findRe = (q, flags = "i") => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

// Search hits marked in the text: <mark style="background-color: …"> put into the markdown
// itself (a bare <mark> is a fixed pale yellow the light text can't be read on). Written just
// so: without the space after "background-color:", or with other HTML (<code>, <a>) beside it,
// TextView read the whole message as HTML and its markdown showed as typed (tested 2026-11-02).
// So nothing else changes: marks go into plain text and link text, around a whole code span,
// never into a code block, a table (HTML breaks it) or a link's address.
const MARK = { hit: "#1E7A4C66", current: "#1E7A4CCC" };
// Text with every hit of `re` (global) marked; `esc` escapes the text around and in them.
const marker = (re, color, esc = (s) => s) => (s) => {
  let out = "", last = 0;
  for (const m of s.matchAll(re)) {
    if (!m[0]) break;
    out += `${esc(s.slice(last, m.index))}<mark style="background-color: ${color}">${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
};
// Escapes, code spans, **strong** / *em* / ~~strike~~, [links](…) and images, <autolinks>.
const INLINE = /\[!-\/:-@[-`{-~]|(`+).+?\1(?!`)|(\*\*|__|\*|~~)(\S(?:.*?\S)?)\2|(!?\[)([^\]]*)(\]\([^)]*\))|<https?:\/\/[^>\s]+>/g;
function markInline(s, mark, test, color) {
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += mark(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += test.test(m[0]) ? `<mark style="background-color: ${color}">${m[0]}</mark>` : m[0];
    else if (m[2] !== undefined) out += m[2] + markInline(m[3], mark, test, color) + m[2];
    else if (m[4] !== undefined) out += m[4] + (m[4] === "[" ? markInline(m[5], mark, test, color) : m[5]) + m[6];
    else out += m[0];
  }
  return out + mark(s.slice(last));
}
// Claude's markdown with the hits of `re` (global) marked, line by line after any list, quote
// or heading marker.
function markMarkdown(md, re, color) {
  const test = new RegExp(re.source, "i");
  const mark = marker(re, color);
  let fence = null;
  return md.split("\n").map((l) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return l; }
    if (f) { fence = f[1]; return l; }
    if (/^\s*\|/.test(l) || !test.test(l)) return l;
    const [, head, rest] = /^(\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?)(.*)$/.exec(l);
    return head + markInline(rest, mark, test, color);
  }).join("\n");
}
// Claude's markdown cut at its code blocks, so each can have a copy button (TextView draws a
// whole message and has no hook per block): [{ md }] or [{ md, code }], `code` = the block's
// body. Same fence rule as markMarkdown, but only fences at the line's start: one inside a list
// or quote stays in its text (cut out, the list would lose its numbering and indent). An
// unclosed fence runs to the end. Null when there is no block; kept on the item.
function codeParts(item) {
  if (item.parts !== undefined) return item.parts;
  item.parts = null;
  if (!/^(`{3,}|~{3,})/m.test(item.text)) return null;
  const parts = [];
  let text = [], block = null, fence = null;
  const flush = () => { if (text.join("").trim()) parts.push({ md: text.join("\n") }); text = []; };
  for (const l of item.text.split("\n")) {
    const f = /^(`{3,}|~{3,})/.exec(l);
    if (fence) {
      block.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.slice(f[1].length).trim()) {
        parts.push({ md: block.join("\n"), code: block.slice(1, -1).join("\n") });
        fence = null;
      }
    } else if (f) { flush(); fence = f[1]; block = [l]; }
    else text.push(l);
  }
  if (fence) parts.push({ md: block.join("\n"), code: block.slice(1).join("\n") });
  else flush();
  return (item.parts = parts);
}
// Your message (see plainMarkdown) with the hits marked.
const plainMarked = (s, re, color) => s.replace(/\r/g, "").split(/\n\s*\n/)
  .map((p) => p.split("\n").map(marker(re, color, plainEscape)).join("\\\n")).join("\n\n");

// Terminal ⇄ Chat slide switch; the knob slides, then the view flips (layout.select).
const SLIDE_MS = 170;
// Animation Off (shared "p5.motion" false): a busy glyph stands still; the glyph itself stays.
const spinning = (glyph, ms) => (shared("p5.motion") === false ? glyph : glyph.spin(ms));
function slideSwitch(t, id, chatOn, onToggle) {
  const W = 64, H = 22, K = 30;
  return div().id(id).relative().w(W).h(H).flex_none().rounded(11).bg(t.surface).border_1().border_color(t.border).cursor_pointer()
    .hover((s) => s.border_color(t.input))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onToggle(cx); })
    .child(div().absolute().top(1).left(chatOn ? W - K - 3 : 1).w(K).h(H - 4).rounded(9).bg(t.accent).when(shared("p5.motion") !== false, (el) => el.transition("left", SLIDE_MS)))
    .child(h_flex().absolute().top(0).left(0).w(W - 2).h(H - 2).items_center()
      .child(h_flex().w((W - 2) / 2).justify_center().tooltip("Terminal")
        .child(svg("mods/agent-header/icons/terminal.svg").size(13).text_color(chatOn ? t.dim : t.accent_foreground)))
      .child(h_flex().w((W - 2) / 2).justify_center().tooltip("Chat")
        .child(svg("mods/agent-header/icons/chat.svg").size(13).text_color(chatOn ? t.accent_foreground : t.dim))));
}



// ---------- file links: paths in replies open in the right panel (file-view) ----------
// A link the chat makes for a file; TextView reports clicks on it through on_link_click.
const OPEN_URL = "https://herdr.open/?p=";
// Extensions worth opening in the viewer.
const FILE_EXT = "md|markdown|mdx|txt|json|jsonc|ya?ml|toml|ini|env|csv|log|js|mjs|cjs|jsx|ts|tsx|mts|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|cmd|html|css|scss|sql|xml|svg|vue|svelte|lua|dart|gradle|properties|lock|png|jpe?g|gif|webp|bmp";
// A whole `inline code` span that is a path (absolute, ./relative or a/b.ext), with an optional :line.
const PATH_IN_CODE = new RegExp(String.raw`^(?:[A-Za-z]:[\\/]|[.~]{0,2}[\\/]?)[^\s<>|*?"]*?[^\s<>|*?"\\/]\.(?:` + FILE_EXT + String.raw`)(?::\d+)?$`, "i");
// A bare absolute Windows path in running text (with optional :line).
const ABS_PATH = new RegExp(String.raw`(^|[\s(\[])([A-Za-z]:[\\/][^\s<>|*?"()\[\]]+\.(?:` + FILE_EXT + String.raw`)(?::\d+)?)(?=$|[\s).,;:!?\]])`, "gi");
const isWinAbs = (p) => /^[A-Za-z]:[\\/]/.test(p);
function parsePathRef(p, cwd) {
  const m = /:(\d+)$/.exec(String(p ?? ""));
  const line = m ? Number(m[1]) : null;
  const clean = String(p ?? "").replace(/:\d+$/, "").replace(/^~(?=[\\/])/, home());
  const path = isWinAbs(clean) || !cwd
    ? clean.replace(/\//g, "\\")
    : `${cwd.replace(/[\\/]+$/, "")}\\${clean.replace(/^\.[\\/]/, "").replace(/\//g, "\\")}`;
  return { path, line: Number.isInteger(line) && line > 0 ? line : null };
}
function resolvePath(p, cwd) {
  return parsePathRef(p, cwd).path;
}
const linkTo = (label, path, line = null) =>
  `[${label}](${OPEN_URL}${encodeURIComponent(path)}${line ? `&line=${line}` : ""})`;
function decodeViewerUrl(url) {
  const rest = url.slice(OPEN_URL.length);
  const [rawPath, linePart] = rest.split("&line=");
  const line = linePart ? Number(linePart) : null;
  return { path: decodeURIComponent(rawPath), line: Number.isInteger(line) && line > 0 ? line : null };
}
// Markdown with file paths as links: `inline code` that is a path, and bare absolute paths.
// Code blocks are left alone (codeParts hands them over separately).
// For each row, the closest earlier user or claude item (or null), in one pass.
function speakersBefore(items) {
  const out = new Array(items.length);
  let last = null;
  for (let k = 0; k < items.length; k++) {
    out[k] = last;
    const x = items[k];
    if (x.kind === "user" || x.kind === "claude") last = x;
  }
  return out;
}

// The previous speaker of row i, computed once per history version instead of per row.
function speakerOf(view, i) {
  const c = view.speakerCache;
  if (!c || c.items !== view.items || c.length !== view.items.length || c.version !== view.version) {
    view.speakerCache = { items: view.items, length: view.items.length, version: view.version, prev: speakersBefore(view.items) };
  }
  return view.speakerCache.prev[i] ?? null;
}

function linkify(md, cwd) {
  return md.split(/(`[^`\n]+`)/).map((piece) => {
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) {
      const inner = piece.slice(1, -1).trim();
      if (!PATH_IN_CODE.test(inner)) return piece;
      const ref = parsePathRef(inner, cwd);
      return linkTo(piece, ref.path, ref.line);
    }
    // Leave existing links' targets alone: only text outside "](...)" is linked.
    return piece.replace(ABS_PATH, (all, lead, raw) => {
      const ref = parsePathRef(raw, cwd);
      return `${lead}${linkTo(raw.replace(/\\/g, "\\\\"), ref.path, ref.line)}`;
    });
  }).join("");
}
function openInViewer(path, rows = null, line = null) {
  setShared("view.open", {
    path,
    at: Date.now(),
    ...(rows?.length ? { rows: rows.slice(0, 4000) } : {}),
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
  });
}

// The Chat / Terminal switch, the same in my-pane's header (a mod can't import another's).
function viewSwitch(t, here, flip) {
  const seg = (id, label) => div().id(`view-${id}`).px(8).h(20).flex().items_center().rounded(5)
    .text_size(11.5).font_medium()
    .when(id === here, (el) => el.bg(t.selected).text_color(t.foreground))
    .when(id !== here, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); flip(); }))
    .child(label);
  return h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border)
    .child(seg("chat", "Chat")).child(seg("terminal", "Terminal"));
}

// A tab running Claude before Herdr sees an agent there (its first seconds): it opens on the
// chat, not the terminal. `panes()` knows the program at once (key "claude"); `terminals()`
// doesn't list a new terminal yet (seen 2026-11-01).
function starting(tab) {
  return tab != null && panes().some((p) => p.tab === tab && p.terminal && /^(claude|pi|codex|opencode)/.test(p.program?.key ?? ""));
}


export default class ClaudeChat extends View {
  init(_props, cx) {
    if (props()?.settings) {
      // Hex boxes for any background or text color; a full #rrggbb takes effect as it's typed.
      const look = chatLook();
      this.hex = {};
      for (const key of ["bg", "fg"]) {
        const s = InputState.new({ placeholder: "#hex", value: HEX.test(look[key]) ? look[key] : "" });
        s.on("change", () => {
          const v = s.value().trim().replace(/^#?/, "#");
          if (HEX.test(v) && v.toLowerCase() !== String(chatLook()[key]).toLowerCase()) setLook({ [key]: v });
        });
        this.hex[key] = s;
      }
      // null while programs.json is read; "error" if it isn't valid JSON (left alone then).
      this.dev = null;
      cx.spawn(async (cx) => {
        try { this.dev = await devContainerOn(); } catch { this.dev = "error"; }
        cx.notify();
      });
      return;
    }
    this.cache = new Map();
    this.reset(null);
    this.open = new Set();
    // Earlier turns whose work was clicked open, as "<address>:<index of its first item>".
    this.unfolded = new Set();
    // Images pasted for a dev container's Claude: their paths in the container, by agent address,
    // sent with the next message (see pasteIntoContainer).
    this.pasted = new Map();
    // Visual image attachments staged under appHome() (pi-images/), by agent address.
    this.attached = new Map();
    this.draftStore = new DraftStore();
    this.histories = new Map();
    this.recentImages = [];
    this.projectFiles = [];
    this.projectFilesCwd = null;
    this.projectFilesAt = 0;
    this.box = TextareaState.new({ placeholder: "Message the agent…  (Enter: send · ↑↓: history · @: files/images)" });
    this.box.set_auto_grow(1, 8);
    this.keyboard = cx.focus_handle();
    this.typed = ""; this.menuAt = 0; this.menuOff = false;
    // The "/word" or "@query" being typed at caret, or null.
    this.slash = null;
    this.mention = null;
    this.mentionAtIdx = 0;
    this.mentionOff = false;
    // The right-click menu over the log: { x, y (in the log), text (the message under the pointer) }.
    this.ctx = null;
    // A redraw rebuilds every message, so typing redraws only for / or @ menus (the box draws its own text).
    this.box.on("change", (_e, cx) => {
      const was = this.typed, had = this.slash, hadMention = this.mention;
      this.typed = this.box.value();
      if (!this.settingDraft && this.typed !== was) {
        this.pauseFestiveForTyping(cx);
        this.historyFor?.(this.address)?.resetNavigation();
        if (this.address && this.draftStore) this.draftStore.set(this.address, this.typed);
      }
      // Enter's newline, typed at the word (it arrives before submit): keep the menu as it was
      // for submit to use; complete() drops the newline.
      if (had && this.typed === was.slice(0, had.end) + "\n" + was.slice(had.end)) return;
      if (hadMention && this.typed === was.slice(0, hadMention.end) + "\n" + was.slice(hadMention.end)) return;
      // Plain drafts cannot open / or @ menus; avoid scanning for the caret or redrawing the log.
      const hasSlash = this.typed.includes("/");
      const hasMention = !hasSlash && typeof mentionAt === "function" && this.typed.includes("@");
      const caret = (hasSlash || hasMention) ? (this.box.selected_range?.()?.start ?? caretAfter(was, this.typed)) : 0;
      this.slash = hasSlash ? slashAt(this.typed, caret) : null;
      this.mention = !this.slash && hasMention ? mentionAt(this.typed, caret) : null;
      let dirty = false;
      if (!sameSlash(had, this.slash)) {
        this.menuAt = 0;
        this.menuOff = false;
        if (had || this.slash) dirty = true;
      }
      if (typeof sameMention === "function" && !sameMention(hadMention, this.mention)) {
        this.mentionAtIdx = 0;
        this.mentionOff = false;
        if (this.mention) this.refreshMentionSources?.(cx);
        if (hadMention || this.mention) dirty = true;
      }
      if (dirty) cx.notify();
    });
    // Enter has already put its newline in; Shift+Enter keeps it. With @ or / open,
    // Enter applies the highlighted suggestion; otherwise sends the message.
    this.box.on("submit", (e, cx) => {
      if (e.shift) return;
      const mPick = this.mentionMatches()[this.mentionAtIdx];
      if (mPick) { this.completeMention(mPick, cx); return cx.notify(); }
      const pick = this.matches()[this.menuAt];
      if (pick && this.slash.start > 0) { this.complete(pick[0]); return cx.notify(); }
      if (pick) this.setDraft(`/${pick[0]}${this.slash.text.slice(this.slash.end)}`);
      this.send(cx);
    });
    this.box.on("paste_other", (_e, cx) => this.pasteImage(cx));
    // Menu and history keys under deeper contexts so they run before Textarea's built-in arrows/Tab/Esc.
    try {
      cx.bind_keys(["Input", "Textarea", "TextArea"].flatMap((box) => [
        ["down", "claude_chat_menu_down"], ["up", "claude_chat_menu_up"], ["tab", "claude_chat_menu_fill"],
        ["escape", "claude_chat_menu_close"], ["left", "claude_chat_menu_leave"], ["right", "claude_chat_menu_leave"],
        ["home", "claude_chat_menu_leave"], ["end", "claude_chat_menu_leave"],
      ].map(([keystroke, action]) => ({ keystroke, action, context: `ChatSlash > ${box}` }))));
      cx.bind_keys(["Input", "Textarea", "TextArea"].flatMap((box) => [
        ["up", "claude_chat_history_up"], ["down", "claude_chat_history_down"],
      ].map(([keystroke, action]) => ({ keystroke, action, context: `ChatHistory > ${box}` }))));
      // Esc while working = Stop (the composer is "ChatStop" then, with the menu closed).
      cx.bind_keys(["Input", "Textarea", "TextArea"].map((box) => ({ keystroke: "escape", action: "claude_chat_stop", context: `ChatStop > ${box}` })));
    } catch {}
    // Search (Ctrl+F, or the header's magnifier): findQ is the query in use (typing settles for
    // 150 ms first, since a redraw rebuilds every message), findList its hits oldest first
    // ({ item, id }: id = the row's), findAt the current one. seek: the row to scroll to.
    this.findOpen = false; this.findQ = ""; this.findList = []; this.findAt = null; this.findKey = null; this.findWhat = null;
    this.findBox = InputState.new({ placeholder: "Search this chat" });
    this.findKeys = cx.focus_handle();
    this.rootKeys = cx.focus_handle();
    this.findBox.on("change", (_e, cx) => {
      const gen = (this.findGen = (this.findGen ?? 0) + 1);
      cx.timer.after(150, (cx) => {
        if (gen !== this.findGen) return;
        this.findQ = this.findBox.value().trim();
        cx.notify();
      });
    });
    // From the newest hit up: Enter goes to the older one, Shift+Enter the newer.
    this.findBox.on("submit", (e, cx) => this.findStep(e.shift ? 1 : -1, cx));
    cx.timer.every(2000, (cx) => this.tick(cx));
    this.tick(cx);
    cx.spawn(async (cx) => { for (;;) { const c = await nextCommand(); if (c === "toggle") this.toTerminal(this.address);
      else if (typeof c === "string" && c.startsWith("pi-command-palette-")) this.openPiCommands(c, cx);
      else if (c === "bigger") setLook({ size: Math.min(24, chatLook().size + 1) });
      else if (c === "smaller") setLook({ size: Math.max(10, chatLook().size - 1) });
      else if (c === "reset-size") setLook({ size: LOOK_DEFAULT.size }); } });
  }

  // One local idle deadline and timer per burst. Only the start and end invalidate shared state.
  pauseFestiveForTyping(cx) {
    if (shared("p5.motion") === false) return;
    const now = Date.now();
    if (this.typingBurst) { this.typingBurst.until = now + TYPING_IDLE_MS; return; }
    if (props()?.block !== "chat-body" || shared(LOOK)?.width === "full" || checking()) return;
    const owner = now.toString(36) + Math.random().toString(36).slice(2);
    const burst = { owner, until: now + TYPING_IDLE_MS, renewAt: now + TYPING_LEASE_MS / 2 };
    this.typingBurst = burst;
    setShared(TYPING_SHARED_KEY, { owner, expiresAt: now + TYPING_LEASE_MS });
    cx.timer.after(TYPING_IDLE_MS, (cx) => this.checkFestiveTyping(burst, cx));
  }

  checkFestiveTyping(burst, cx) {
    if (this.typingBurst !== burst) return;
    const now = Date.now();
    if (now >= burst.until || shared("p5.motion") === false || shared(TYPING_SHARED_KEY)?.owner !== burst.owner) {
      this.clearFestiveTyping();
      return;
    }
    // Long typing bursts renew the watchdog using a mod command, not a persisted shared write.
    const renew = now >= burst.renewAt;
    if (renew) burst.renewAt = now + TYPING_LEASE_MS / 2;
    cx.timer.after(Math.min(burst.until, burst.renewAt) - now, (cx) => this.checkFestiveTyping(burst, cx));
    if (renew) run(`festive-rail.typing-lease-${burst.owner}-${now + TYPING_LEASE_MS}`);
  }

  clearFestiveTyping() {
    const burst = this.typingBurst;
    this.typingBurst = null;
    if (burst && shared(TYPING_SHARED_KEY)?.owner === burst.owner) setShared(TYPING_SHARED_KEY, null);
  }

  async close() {
    this.clearFestiveTyping();
  }

  // Restoring or clearing a draft still uses the ordinary change handler, but is not typing.
  setDraft(text) {
    this.settingDraft = true;
    try { this.box.set_value(text); } finally { this.settingDraft = false; }
  }

  // Each agent's chat is kept, so going back to one shows it at once; the tick then catches up.
  reset(address) {
    if (this.address) this.cache.set(this.address, { where: this.where, session: this.session, file: this.file,
      pos: this.pos, items: this.items, tools: this.tools, skills: this.skills, subs: this.subs, looked: this.looked, lastReply: this.lastReply,
      model: this.model, effort: this.effort, usage: this.usage, piMeta: this.piMeta, draft: this.box?.value() ?? "", images: this.images ?? 0 });
    this.epoch = (this.epoch ?? 0) + 1;
    this.watched = null; this.busy = null;
    this.address = address;
    this.kind = kindOf(this.candidates().find((a) => a.address === address));
    this.stamp = null;
    const kept = this.cache.get(address) ?? {};
    const draft = kept.draft ?? (address && this.draftStore ? this.draftStore.get(address) : "");
    if (this.box) {
      this.settingDraft = true;
      try { this.box.set_value(draft); } finally { this.settingDraft = false; }
    }
    this.typed = draft; this.images = kept.images ?? 0;
    this.slash = null; this.menuAt = 0; this.menuOff = false;
    this.mention = null; this.mentionAtIdx = 0; this.mentionOff = false;
    this.pasteNote = null;
    this.where = kept.where ?? null; this.session = kept.session ?? null; this.file = kept.file ?? null; this.pos = kept.pos ?? 0;
    this.items = kept.items ?? []; this.tools = kept.tools ?? new Map(); this.skills = kept.skills ?? new Map();
    this.piMeta = kept.piMeta ?? null;
    this.piCommandMeta = null; this.piCommandRoute = null; this.piCommandOpen = null;
    // subs: each sub-agent by the id of the tool call that started it; trail: the ones opened.
    this.subs = kept.subs ?? new Map(); this.trail = [];
    this.looked = kept.looked ?? 0; this.stale = Boolean(kept.file); this.lastReply = kept.lastReply ?? null;
    // The model as the transcript last named it (a reply's, or /model's output), and the effort
    // /effort last set: { level, model } (the model it was set on).
    this.model = kept.model ?? null; this.effort = kept.effort ?? null;
    this.usage = kept.usage ?? newUsage();
    this.drop = null; this.pickNote = null;
    this.limit = PAGE; this.problem = null; this.screen = null; this.up = 0;
    this.rowH = new Map(); this.seek = null;
    if (address && this.histories && this.historyFor) this.historyFor(address).seedFromItems(this.items);
  }

  // The other Claude agents' sessions, found ahead of time (one process walk for all), so
  // switching to one doesn't wait for it.
  async warm() {
    // candidates(), not agents(): OpenCode panes report no status and are missing from agents().
    const live = new Set(this.candidates().map((a) => a.address));
    for (const address of [...this.cache.keys()]) if (!live.has(address)) this.cache.delete(address);
    const todo = agents().filter((a) => a.app === "claude-code" && a.address !== this.address
      && !this.cache.get(a.address)?.where && Date.now() - (this.cache.get(a.address)?.looked ?? 0) > 30000);
    if (!todo.length) return;
    const tree = await children();
    for (const { address } of todo) {
      const where = await locate(address, tree).catch(() => null);
      if (address !== this.address) this.cache.set(address, { ...this.cache.get(address), where, looked: Date.now() });
    }
  }

  // The sessions the agents other than `address` are on (and the ones their session files name),
  // for `followResume`.
  takenBy(address) {
    const ids = new Set();
    const add = (a, where, session) => {
      if (a === address) return;
      if (session?.sessionId) ids.add(session.sessionId);
      if (where?.fileId) ids.add(where.fileId);
    };
    for (const [a, kept] of this.cache) if (a !== this.address) add(a, kept.where, kept.session);
    add(this.address, this.where, this.session);
    return ids;
  }

  // The other Claude agents' sub-agents (their meta files only), every 6 s, so the count covers
  // every agent. A changed session (/clear) starts what's kept of that agent over.
  async scanOthers() {
    if (Date.now() - (this.scanned ?? 0) < 6000) return;
    this.scanned = Date.now();
    for (const { address } of agents().filter((a) => a.app === "claude-code" && a.address !== this.address)) {
      const kept = this.cache.get(address);
      if (!kept?.where) continue;
      const session = await sessionOf(kept.where, () => this.takenBy(address)).catch(() => null);
      if (!session || address === this.address || this.cache.get(address) !== kept) continue;
      if (session.sessionId !== kept.session?.sessionId || !kept.file) {
        const file = await fileOf(kept.where, session);
        Object.assign(kept, { session, file, pos: 0, items: [], tools: new Map(), skills: new Map(), subs: new Map() });
      }
      if (kept.file) await this.readSubs(kept.where, kept.subs, kept.file.replace(/\.jsonl$/, "/subagents"), true).catch(() => {});
    }
  }

  // Shares how many sub-agents each agent has at work (SUBS), when that changed.
  publish() {
    const counts = {};
    const count = (address, subs, tools) => {
      const n = [...(subs ?? [])].filter(([id, s]) => subRunning(s, tools?.get(id))).length;
      if (address && n) counts[address] = n;
    };
    for (const [address, kept] of this.cache) if (address !== this.address) count(address, kept.subs, kept.tools);
    count(this.address, this.subs, this.tools);
    const key = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
    if (key(counts) !== key(shared(SUBS))) setShared(SUBS, counts);
    // Which dev container each Claude runs in (its id or name, as `docker exec` got it), for
    // my-status: the container's /workspace holds the repos that agent works on.
    const boxes = {};
    for (const [address, kept] of this.cache) if (address !== this.address && kept.where?.container) boxes[address] = kept.where.container;
    if (this.address && this.where?.container) boxes[this.address] = this.where.container;
    if (key(boxes) !== key(shared(CONTAINERS))) setShared(CONTAINERS, boxes);
  }

  // props.terminal, else the shown tab's Claude (the focused one when it has several).
  // Every chat-able terminal: Herdr's agents, plus panes running an agent that reports no
  // status (OpenCode), shaped like agents() entries.
  candidates() {
    const list = agents().filter((a) => kindOf(a));
    const known = new Set(list.map((a) => a.address));
    for (const p of panes()) {
      if (!p.terminal || known.has(p.terminal)) continue;
      const a = { address: p.terminal, pane: p.pane, tab: p.tab, status: p.status ?? "idle", app: p.app, program: p.program,
        title: p.title, space_name: spaces().find((s) => s.tabs?.some((t) => t.id === p.tab))?.name ?? "", pinned: false, focused: p.focused };
      if (kindOf(a)) list.push(a);
    }
    return list;
  }

  target() {
    const claude = this.candidates();
    if (props()?.terminal) return claude.find((a) => a.address === props().terminal) ?? null;
    const f = focused();
    const mine = claude.filter((a) => a.tab === f?.tab);
    return mine.find((a) => a.address === (f?.agent ?? f?.terminal)) ?? mine.find((a) => a.address === this.address) ?? mine[0] ?? null;
  }

  // In a layout stack (props { stack, self, other }): the chat and the tab's terminals take
  // turns. Whether the chat shows now, from the layout with its clicks.
  showing() {
    const { stack, self } = props() ?? {};
    if (!stack) return true;
    const find = (node) => (node?.id === stack ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    return (node?.active ?? node?.children?.[0]?.id) === self;
  }

  // A tab with no Claude in it (and none starting) always shows the Terminal: the chat has
  // nothing to show there. The stack is shared by every tab, so it flips back to the chat as
  // soon as a Claude runs there (or on going to a tab with one): the first message can be typed
  // in the chat, it goes by `hc send` like any other. Only a flip made here goes back: Terminal
  // picked by hand stays.
  autoView(agent) {
    const { stack, self, other } = props() ?? {};
    const tab = focused()?.tab;
    if (!stack || props()?.terminal || tab == null) return;
    const empty = !agent && !starting(tab);
    const showing = this.showing();
    if (showing) this.flipped = false;
    if (empty && showing) {
      this.flipped = true;
      run("layout.select", { stack, child: other });
    } else if (this.flipped && !empty) {
      this.flipped = false;
      run("layout.select", { stack, child: self });
    }
  }

  // Claude's settings for the shown agent: this computer's ~/.claude/settings.json, or the
  // container's own (read in tick). Unknown (null) until the agent is found.
  settingsNow() {
    if (!this.where) return null;
    return this.where.container ? this.containerSettings?.[this.where.container]?.s ?? null : this.claudeSettings;
  }

  // The effort the shown session runs at: what /effort set on this model, else the default
  // Claude's settings keep for the model.
  effortNow() {
    const model = this.modelNow();
    if (!model) return null;
    if (this.effort?.model === model) return this.effort.level;
    const s = this.settingsNow();
    return s?.modelSettings?.[modelId(model)]?.effortLevel ?? s?.effortLevel ?? null;
  }

  // The model: as the transcript last named it, else (a new session, no transcript yet) the
  // default in Claude's settings.
  modelNow() {
    if (this.model) return this.model;
    const m = this.settingsNow()?.model;
    return MODELS.find(([alias]) => alias === m)?.[1] ?? (/^claude-/.test(m ?? "") ? modelLabel(m) : null);
  }

  // A pick from the model / effort bar, made in Claude's own /model or /effort picker with its
  // "s" key (this session only): `/model opus`, `/effort high` and a digit in the picker all
  // also save it as the default for new sessions (Claude 2.1.318, 2026-11-05). The header says
  // "Switching…" until the transcript shows the change (`pending`), or after 12 s that it didn't.
  pick(kind, value, address, cx) {
    this.drop = null;
    // The picker's keys would land in a box that's open on Claude's screen (see boxText).
    if (this.screen) { this.pickNote = "Close the box in Claude's terminal first"; return cx.notify(); }
    this.pending = { kind, value, address, until: Date.now() + 12000 };
    this.pickNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const screen = async () => (await hc(["read", address])).stdout.replace(/\r/g, "");
      // Types the command, waits for its picker (`ready` tests the screen), then `keys`.
      const inPicker = async (command, ready, what) => {
        await hc(["keys", address, ...command.split("")]);
        await hc(["keys", address, "enter"]);
        for (let i = 0; i < 20; i++) {
          await cx.sleep(150);
          if (ready(await screen())) return;
        }
        await hc(["keys", address, "esc"]);
        throw new Error(`Claude's ${what} picker didn't open`);
      };
      try {
        if (kind === "model") {
          // Rows "N.  Opus 5.5   …" (row 1 is "Default (recommended)"); Home goes to row 1.
          // The family's first row, under the name the list gives it (see MODELS).
          const row = new RegExp(`^\\s*(?:❯\\s*)?(\\d+)\\.\\s+(${family(value)}\\b[^\\n]*?)(?:\\s*✔)?(?:\\s{2,}|\\s*$)`, "m");
          await inPicker("/model", (s) => /Select model/.test(s) && row.test(s), "model");
          const found = row.exec(await screen());
          const n = Number(found?.[1] ?? 0);
          if (!n) throw new Error(`${value} isn't in Claude's /model list`);
          value = found[2].trim();
          if (this.pending?.address === address && this.pending.kind === "model") this.pending.value = value;
          await hc(["keys", address, "home", ...Array(n - 1).fill("down")]);
          await cx.sleep(100);
          // Only on the right row (the list could have moved): else leave it untouched.
          const at = /^\s*❯\s*\d+\.\s+(.*?)\s{2,}/m.exec(await screen())?.[1];
          if (at?.replace(/\s*✔$/, "") !== value) { await hc(["keys", address, "esc"]); throw new Error(`Couldn't select ${value}`); }
          await hc(["keys", address, "s"]);
        } else {
          // The effort slider starts at the current level; ← five times is low.
          await inPicker("/effort", (s) => /Faster[\s\S]*Smarter/.test(s), "effort");
          await hc(["keys", address, ...Array(5).fill("left"), ...Array(EFFORTS.indexOf(value)).fill("right"), "s"]);
        }
        // Mid-conversation Claude asks first ("Change effort level? … the full history gets
        // re-read on your next message", "❯ 1. Yes, switch to low"): the pick was the answer.
        for (let i = 0; i < 8; i++) {
          await cx.sleep(200);
          if (/^\s*❯\s*1\.\s+Yes, switch/m.test(await screen())) { await hc(["keys", address, "enter"]); break; }
        }
      } catch (e) {
        this.pending = null;
        this.pickNote = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // Whether the pick in flight has landed (the transcript names it) or timed out.
  settlePick() {
    const p = this.pending;
    if (!p || p.address !== this.address) return;
    const now = p.kind === "model" ? this.model : this.effortNow();
    if (now === p.value) this.pending = null;
    else if (Date.now() > p.until) { this.pending = null; this.pickNote = "No change seen: look at the Terminal"; }
  }

  // The model and effort dropdowns at the right of the box: the trigger shows the current one
  // (or "Opus 5.5…" while a pick lands), the list opens upward with the current one ticked.
  // Picks only while Claude waits for you: a pick while it works would queue behind the turn,
  // and keys typed into the effort picker would land in its prompt instead.
  dropdown(t, agent, kind) {
    const ready = agent.status !== "working" && agent.status !== "blocked";
    const now = kind === "model" ? this.modelNow() : this.effortNow();
    const p = this.pending?.address === this.address && this.pending.kind === kind ? this.pending : null;
    const open = this.drop === kind;
    const options = kind === "model" ? MODELS.map(([, label]) => (family(now) === family(label) ? now : label)) : EFFORTS;
    const trigger = h_flex().id(`drop-${kind}-trigger`).flex_none().gap(4).px(8).h(28).items_center().rounded(7)
      .border(1).border_color(open ? t.accent : t.border).bg(t.background).cursor_pointer()
      .text_size(px(12)).text_color(p ? t.accent : t.muted)
      .hover((s) => s.text_color(t.foreground).border_color(t.input))
      .tooltip(kind === "model" ? "Model (this session only)" : "Effort (this session only)")
      .child(p ? `${p.value}…` : now ?? (kind === "model" ? "Model" : "Effort"))
      .child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.dim));
    const row = (value) => h_flex().id(`drop-${kind}-${value}`).gap(8).px(8).h(26).items_center().rounded(5).text_size(px(12.5))
      .when(value === now, (el) => el.text_color(t.foreground).bg(t.selected))
      .when(value !== now && ready, (el) => el.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.drop = null; this.pick(kind, value, agent.address, cx); this.box.focus(); }))
      .when(value !== now && !ready, (el) => el.text_color(t.dim))
      .child(div().w(12).flex_none().text_color(t.accent).child(value === now ? "✓" : ""))
      .child(value);
    return Popover.new(`drop-${kind}`).anchor("bottom_right")
      .open(open)
      .on_open_change((o, cx) => { this.drop = o ? kind : null; this.pickNote = null; cx.notify(); })
      .trigger(trigger)
      .content(v_flex().w(kind === "model" ? 190 : 230).p(4).gap(1).mb(6).rounded(8).bg(t.popover).border(1).border_color(t.border)
        .children(options.map(row))
        .child(div().px(8).pt(6).pb(2).text_size(px(10.5)).text_color(t.dim)
          .child(!ready ? "Can change once Claude stops"
            : kind === "effort" ? "This session only. Mid-chat, the next reply re-reads the history." : "This session only")));
  }

  toTerminal(address) {
    const { stack, other } = props() ?? {};
    if (stack) run("layout.select", { stack, child: other });
    if (address) run("pane.focus", { terminal: address });
  }

  // Every 2 s: which session the agent is on now (/clear and /resume change it), and while
  // it's asking something, the bottom of its screen.
  tick(cx) {
    if (!this.warming) {
      this.warming = true;
      cx.spawn(async () => { try { await this.warm(); await this.scanOthers(); this.publish(); } finally { this.warming = false; } });
    }
    // Claude's own settings, for the effort a session starts on (see effortNow), every 30 s.
    if (Date.now() - (this.claudeSettingsAt ?? 0) > 30000) {
      this.claudeSettingsAt = Date.now();
      cx.spawn(async (cx) => {
        const text = await readFile(`${CLAUDE}/settings.json`, "utf8").catch(() => null);
        let s = null;
        try { s = text ? JSON.parse(text) : null; } catch {}
        if (JSON.stringify(s) !== JSON.stringify(this.claudeSettings)) { this.claudeSettings = s; cx.notify(); }
      });
    }
    // A dev container's Claude has its own settings (its CLAUDE_CONFIG_DIR): read them there,
    // every 30 s per container (the effort dropdown showed nothing for container agents).
    const container = this.where?.container;
    if (container) {
      const kept = (this.containerSettings ??= {})[container];
      if (Date.now() - (kept?.at ?? 0) > 30000) {
        this.containerSettings[container] = { ...kept, at: Date.now() };
        const where = this.where;
        cx.spawn(async (cx) => {
          const r = await inDocker(where, 'cat "$d/settings.json" 2>/dev/null').catch(() => null);
          let s = null;
          try { s = r?.stdout?.trim() ? JSON.parse(r.stdout) : null; } catch {}
          const now = this.containerSettings[container];
          if (JSON.stringify(s) !== JSON.stringify(now?.s)) { this.containerSettings[container] = { ...now, s }; cx.notify(); }
        });
      }
    }
    const agent = this.target();
    if ((agent?.address ?? null) !== this.address) { this.reset(agent?.address ?? null); cx.notify(); }
    this.autoView(agent);
    // One tick at a time per agent; a slow one for the agent left behind doesn't hold this one up.
    if (!agent || this.busy === agent.address) return;
    const address = agent.address, epoch = this.epoch;
    const current = () => this.address === address && this.epoch === epoch;
    this.busy = address;
    // Redraw only when something changed: a redraw rebuilds the markdown, which drops a
    // text selection in progress.
    const before = this.drawn();
    if (kindOf(agent) !== "claude") return this.tickOther(agent, before, cx);
    cx.spawn(async (cx) => {
      try {
        if (!this.where && Date.now() - this.looked > 10000) {
          this.looked = Date.now();
          const where = await locate(address);
          if (!current()) return;
          this.where = where;
          if (!where) this.problem = "Can't find this agent's Claude session.";
        }
        const where = this.where;
        if (where && current()) {
          const session = await sessionOf(where, () => this.takenBy(address));
          if (!current()) return;
          if (!session) { this.where = null; this.looked = 0; }
          else if (session.sessionId !== this.session?.sessionId || !this.file) {
            // In a container the file is read through docker, relative to its Claude folder.
            const file = where.container ? `projects/${folderName(session.cwd)}/${session.sessionId}.jsonl` : await transcriptOf(session);
            if (!current()) return;
            this.items = []; this.usage = newUsage(); this.tools = new Map(); this.skills = new Map(); this.subs = new Map(); this.trail = []; this.pos = 0; this.limit = PAGE;
            this.session = session; this.file = file; this.problem = file ? null : "No transcript yet: say something.";
            if (file) { await this.load(cx); if (!where.container) this.watch(file, cx); }
          } else if (where.container || this.stale) {
            // Back to a kept chat: read what was added while away, and watch its folder again.
            this.stale = false;
            await this.load(cx);
            if (!where.container && this.address === address) this.watch(this.file, cx);
          }
          if (this.file && this.address === address) await this.loadSubs();
        }
        const askingPending = Boolean(ask.pending(this.items));
        const screen = agent.status === "blocked" || askingPending ? await this.tail(address)
          : agent.status === "working" ? null : await this.boxText(address);
        const live = agent.status === "working" ? await this.liveLine(address) : null;
        if (current()) { this.screen = screen; this.live = live; this.hydrateImages(cx); }
      } catch (e) {
        if (current()) this.problem = String(e?.message ?? e);
      } finally {
        if (!current()) return;
        if (this.busy === address) this.busy = null;
        this.publish();
        if (this.drawn() !== before) cx.notify();
      }
    });
  }

  // Pi / Codex / OpenCode: find the session (again every 10 s: /new starts another), read
  // what was added, and while blocked (or waiting on a question tool) read its screen.
  tickOther(agent, before, cx) {
    const address = agent.address, epoch = this.epoch;
    const current = () => this.address === address && this.epoch === epoch;
    const kind = kindOf(agent);
    cx.spawn(async (cx) => {
      try {
        if (kind === "pi" && typeof runtimeMetadata === "function") {
          const meta = await runtimeMetadata(address).catch(() => null);
          if (current()) {
            if (meta) this.piMeta = meta;
            this.piCommandMeta = meta;
          }
        }
        if (Date.now() - this.looked > 10000 || !this.file) {
          this.looked = Date.now();
          const file = await findSession(kind, address);
          if (!current()) return;
          if (file !== this.file) {
            this.items = []; this.usage = newUsage(); this.tools = new Map(); this.pos = 0; this.limit = PAGE; this.stamp = null;
            this.file = file;
            this.problem = file ? null : `No ${NAMES[kind]} session for this terminal yet: say something.`;
            this.version = (this.version ?? 0) + 1;
            if (file && !file.startsWith("opencode:")) this.watch(file, cx);
          }
        }
        if (this.file) await this.load(cx);
        if (current()) {
          this.historyFor?.(address)?.seedFromItems(this.items);
          this.hydrateImages?.(cx);
        }
        const askingPending = typeof ask !== "undefined" && Boolean(ask.pending?.(this.items));
        const screen = agent.status === "blocked" || askingPending ? await this.tail(address) : null;
        if (current()) this.screen = screen;
      } catch (e) {
        if (current()) this.problem = String(e?.message ?? e);
      } finally {
        if (!current()) return;
        if (this.busy === address) this.busy = null;
        if (this.drawn() !== before) cx.notify();
      }
    });
  }

  // What tick and watch can change on screen.
  drawn() {
    // A model / effort pick in flight: its timeout redraws too (see settlePick).
    const agent = this.target();
    const queued = agent ? this.queuedNow(agent).map((q) => `${q.at}:${Boolean(q.acting)}`).join(",") : "";
    const piCtl = this.piMeta?.control ? `${this.piMeta.control.model?.id ?? ""}:${this.piMeta.control.thinking ?? ""}` : "";
    const commandCatalog = this.piCommandOpen ? this.piCommandCatalog() : null;
    const commandKey = commandCatalog ? JSON.stringify(commandCatalog) : "";
    return `${this.address}|${this.version}|${this.problem}|${this.screen}|${this.live}|${piCtl}|${this.pending ? Date.now() > this.pending.until : ""}|${queued}|${commandKey}`;
  }

  // Claude's working line, read off the bottom of its screen ("✻ Cogitating… (1m · ↓ 12k tokens)").
  async liveLine(address) {
    const r = await hc(["read", address, "--lines", "30"]).catch(() => null);
    const lines = (r?.stdout ?? "").replace(/\r/g, "").split("\n").reverse();
    for (const l of lines) { const m = LIVE_LINE.exec(l); if (m) return m[1].trim(); }
    return null;
  }

  async tail(address) {
    const r = await hc(["read", address]);
    const lines = r.stdout.replace(/\r/g, "").split("\n");
    const nonEmpty = lines.filter((l) => l.trim());
    // Pi menus use unnumbered → / ❯ rows or [i/N] tabs rather than "1. ": keep the full bottom
    // block (up to 45 non-empty lines) so parseScreen sees every option and header.
    let start = Math.max(0, lines.length - 80);
    let first = lines.length - 1;
    while (first > start && !/^\s*[│┃]?\s*(?:❯\s*)?1\.\s/.test(lines[first])) first--;
    if (first === start) {
      return nonEmpty.slice(-45).join("\n");
    }
    for (let i = first; i > start; i--) if (/^\s*[─━╭]{20,}/.test(lines[i])) { start = i; break; }
    return lines.slice(start).filter((l) => l.trim()).join("\n");
  }

  // A box of Claude's own on the screen of an agent Herdr calls idle or done (see BOX_FOOTER):
  // its text, from the last rule down. The chat shows it with keys (status), since a message
  // would be typed into it. null when the screen is the plain prompt.
  async boxText(address) {
    const r = await hc(["read", address]).catch(() => null);
    const text = (r?.stdout ?? "").replace(/\r/g, "");
    if (!boxUp(text)) return null;
    const lines = text.trimEnd().split("\n");
    let start = Math.max(0, lines.length - 40);
    for (let i = lines.length - 1; i > start; i--) if (/^\s*([^\w\s])\1{19,}\s*$/.test(lines[i])) { start = i + 1; break; }
    return lines.slice(start).filter((l) => l.trim()).join("\n");
  }

  watch(file, cx) {
    const dir = file.replace(/[\\/][^\\/]+$/, "");
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          const changed = (await watchFolder(dir)).map((p) => p.replace(/\\/g, "/"));
          if (this.watched !== dir || !this.file) continue;
          const before = this.drawn();
          if (changed.some((p) => p.endsWith(this.file.split(/[\\/]/).pop()))) await this.load(cx);
          if (changed.some((p) => p.includes("/subagents/"))) await this.loadSubs();
          if (this.drawn() !== before) cx.notify();
        }
      } catch { this.watched = null; }
    });
  }

  // Reads what was added since last time. The file only grows; a half-written last line waits.
  async load(_cx) {
    const file = this.file, epoch = this.epoch;
    const current = () => this.epoch === epoch && this.file === file;
    const key = `${epoch}:${file}`;
    if (this.loading === key) { this.again = true; return; }
    this.loading = key;
    try {
      do {
        this.again = false;
        if (this.where?.container) { await this.loadDocker(this.where); continue; }
        if (file.startsWith("opencode:")) {
          const id = file.slice(9);
          const stamp = await opencodeStamp(id);
          if (!current() || stamp === this.stamp) continue;
          // Adapters must never mutate the selected chat across an await.
          const snapshot = { items: [], tools: new Map() };
          const model = await opencodeItems(id, snapshot);
          if (!current()) return;
          this.items = snapshot.items; this.tools = snapshot.tools; this.stamp = stamp;
          if (model) this.model = model;
          this.version = (this.version ?? 0) + 1;
          continue;
        }
        const { text, end, more } = await readAfter(file, this.pos, LOAD_SLICE);
        if (!current()) return;
        if (text === null) {
          this.items = []; this.usage = newUsage(); this.tools = new Map(); this.skills = new Map(); this.subs = new Map(); this.trail = []; this.pos = 0;
          this.again = true;
        } else if (text) { this.ingest(text); this.pos = end; if (more) this.again = true; }
      } while (this.again && current());
    } finally { if (this.loading === key) this.loading = null; }
  }

  // A container's transcript, polled (no folder watch in there): the bytes after `pos`, at most
  // CHUNK at a time (exec's output is capped), up to the last whole line. `into` is this chat or
  // one of its sub-agents (both have file, pos, items, tools).
  async loadDocker(where, into = this) {
    for (;;) {
      const file = into.file;
      const r = await inDocker(where, 'tail -c +"$3" "$d/$2" 2>/dev/null | head -c "$4"', file, String(into.pos + 1), String(CHUNK));
      if (file !== into.file || where !== this.where) return;
      const text = r.stdout;
      const end = text.lastIndexOf("\n") + 1;
      const full = Buffer.from(text, "utf8").length >= CHUNK - 16;
      if (end === 0) {
        // One line longer than a chunk: skip it.
        if (full) into.pos += Number((await inDocker(where, 'tail -c +"$3" "$d/$2" | head -n 1 | wc -c', file, String(into.pos + 1))).stdout.trim()) || 0;
        if (!full) return;
        continue;
      }
      const part = text.slice(0, end);
      this.ingest(part, into);
      into.pos += Buffer.from(part, "utf8").length;
      if (!full) return;
    }
  }

  // The sub-agents' transcripts, each with a .meta.json naming the tool call that started it,
  // read like the main one: only what was added. A finished one is read once more, then left.
  async loadSubs() {
    if (!this.file || this.kind !== "claude") return;
    if (this.subsBusy) { this.subsAgain = true; return; }
    this.subsBusy = true;
    try {
      do {
        this.subsAgain = false;
        await this.readSubs(this.where, this.subs, this.file.replace(/\.jsonl$/, "/subagents"));
      } while (this.subsAgain);
    } finally { this.subsBusy = false; }
  }

  // metasOnly: just the meta files (for the count), not the transcripts.
  async readSubs(where, subs, dir, metasOnly = false) {
    const metas = [];
    if (where?.container) {
      const r = await inDocker(where, 'cd "$d/$2" 2>/dev/null || exit 0; for f in *.meta.json; do [ -f "$f" ] && printf "%s %s\\n" "${f%.meta.json}" "$(tr -d "\\n" < "$f")"; done', dir);
      for (const line of r.stdout.split("\n")) {
        const m = /^(\S+) (\{.*\})$/.exec(line.trim());
        if (m) metas.push([m[1], m[2]]);
      }
    } else {
      const finished = new Set([...subs.values()].filter((s) => s.finished).map((s) => s.name));
      for (const f of await readdir(dir).catch(() => [])) {
        const name = f.endsWith(".meta.json") ? f.slice(0, -".meta.json".length) : null;
        if (name && !finished.has(name)) metas.push([name, await readFile(`${dir}/${f}`, "utf8").catch(() => null)]);
      }
    }
    for (const [name, text] of metas) {
      let meta;
      try { meta = JSON.parse(text); } catch { continue; }
      const key = meta.toolUseId ?? name;
      const sub = subs.get(key) ?? { name, file: `${dir}/${name}.jsonl`, pos: 0, items: [], tools: new Map(), skills: new Map() };
      if (Boolean(meta.finished) !== Boolean(sub.finished)) this.version = (this.version ?? 0) + 1;
      Object.assign(sub, { type: meta.agentType, model: meta.model, about: meta.description, finished: Boolean(meta.finished) });
      subs.set(key, sub);
    }
    if (metasOnly) return;
    for (const sub of subs.values()) {
      if (sub.read) continue;
      const finished = sub.finished;
      if (where?.container) await this.loadDocker(where, sub);
      else {
        const { text, end } = await readAfter(sub.file, sub.pos).catch(() => ({ text: "" }));
        if (text) { this.ingest(text, sub); sub.pos = end; }
      }
      if (finished) sub.read = true;
    }
  }

  // `into`: this chat, or a sub-agent (whose lines are all "sidechain" ones).
  ingest(chunk, into = this) {
    if (into === this && this.kind) trackUsage(this.kind, chunk, this.usage ??= newUsage());
    if (into === this && this.kind && this.kind !== "claude") {
      const model = ingestLines(this.kind, chunk, this);
      if (model) this.model = model;
      this.version = (this.version ?? 0) + 1;
      return;
    }
    for (const line of chunk.split("\n")) {
      // Claude's queue of messages sent during a turn (see queueOp).
      if (into === this && line.startsWith('{"type":"queue-operation"')) { this.queueOp(line); continue; }
      // The conversation's lines; the rest (api requests, snapshots, modes) start with "type".
      if (!line.startsWith('{"parentUuid"')) continue;
      this.version = (this.version ?? 0) + 1;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.isSidechain && into === this) continue;
      if (d.type === "system" && d.subtype === "compact_boundary") into.items.push({ kind: "note", text: "Conversation compacted" });
      if (d.type === "attachment" && d.attachment?.type === "skill_listing" && into === this) this.learnSkills(d.attachment.content);
      // A message sent during a turn, as Claude took it at its next step (2.1.323: an attachment
      // line; before, a reminder in a user line, see said).
      if (d.type === "attachment" && d.attachment?.type === "queued_command" && typeof d.attachment.prompt === "string"
        && (d.attachment.origin?.kind ?? "human") === "human") {
        const text = d.attachment.prompt.trim();
        if (text && !into.items.slice(-6).some((x) => x.mid && x.text === text)) into.items.push({ kind: "user", text, mid: true });
        continue;
      }
      if (d.isMeta || d.isCompactSummary) continue;
      const content = d.message?.content;
      if (d.type === "user") {
        // The reply before this message: a fork "before this message" resumes up to it.
        const before = into === this && this.lastReply?.session === d.sessionId ? this.lastReply.uuid : undefined;
        if (typeof content === "string") this.said(content, into, before);
        else for (const b of content ?? []) {
          if (b.type === "tool_result") {
            const tool = into.tools.get(b.tool_use_id);
            // Kept clipped to what's shown: whole file reads add up, and a big heap makes the
            // garbage collector slow enough to run a render past Herdr's time limit.
            if (tool) {
              tool.result = clip(resultText(b.content)); tool.error = Boolean(b.is_error);
              // An Edit's or Write's patch (its originalFile, the whole file, is not kept).
              const done = d.toolUseResult;
              if (Array.isArray(done?.structuredPatch) && done.filePath === tool.input?.file_path) {
                tool.patch = keepPatch(done.structuredPatch); tool.diff = undefined;
              }
            }
          } else if (b.type === "text") this.said(b.text, into, before);
          else if (b.type === "image") {
            const raw = b.source?.data ? [{ data: b.source.data, mimeType: b.source.media_type ?? "image/png" }] : null;
            into.items.push(raw ? { kind: "user", text: "", rawImages: raw } : { kind: "user", text: "🖼 image" });
          }
        }
      } else if (d.type === "assistant") {
        // Where a fork made at the next message of yours starts from (see fork).
        if (into === this) this.lastReply = { session: d.sessionId, uuid: d.uuid };
        if (into === this && /^claude-/.test(d.message?.model ?? "")) this.model = modelLabel(d.message.model);
        for (const b of content ?? []) {
          if (b.type === "text" && b.text.trim()) into.items.push({ kind: "claude", text: b.text.trim() });
          else if (b.type === "thinking" && b.thinking?.trim()) into.items.push({ kind: "thinking", text: b.thinking.trim() });
          else if (b.type === "tool_use") {
            const tool = { kind: "tool", id: b.id, name: b.name, input: b.input };
            into.tools.set(b.id, tool);
            into.items.push(tool);
          }
        }
      }
    }
  }

  // What the person typed, or what Claude Code put in their turn (slash commands, ! commands).
  said(raw, into = this, before = undefined) {
    // A message sent during a turn reaches Claude inside a reminder, at its next step.
    const mid = /<system-reminder>\s*The user sent a new message while you were working:\n([\s\S]*?)\n\nThis is how Claude Code surfaces/.exec(raw);
    if (mid) return into.items.push({ kind: "user", text: mid[1].trim(), mid: true, before });
    const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
    if (!text || text.startsWith("<local-command-caveat>")) return;
    const command = tag(text, "command-name");
    if (command) return into.items.push({ kind: "user", text: `${command} ${tag(text, "command-args") ?? ""}`.trim() });
    const bash = tag(text, "bash-input");
    if (bash) return into.items.push({ kind: "user", text: `! ${bash}` });
    const out = tag(text, "local-command-stdout") ?? tag(text, "bash-stdout");
    if (out !== undefined && into === this) {
      const model = /^(?:Set model to|Kept model as) `([^`]+)`/.exec(out);
      if (model) this.model = modelLabel(model[1]);
      const effort = /^Set effort level to (\w+)/.exec(out);
      if (effort) this.effort = { level: effort[1], model: this.modelNow() };
    }
    if (out !== undefined) return out && into.items.push({ kind: "note", text: plain(out), mono: true });
    if (text.startsWith("[Request interrupted")) return into.items.push({ kind: "note", text: "Interrupted" });
    if (/^<[\w-]+>/.test(text)) return;
    into.items.push({ kind: "user", text, before });
  }

  // The session's skills ("- name: what it does" lines), for the / menu.
  learnSkills(content) {
    for (const line of String(content ?? "").split("\n")) {
      const m = /^- ([\w:-]+): (.*)/.exec(line);
      if (m) this.skills.set(m[1], m[2]);
    }
  }

  historyFor(address) {
    const key = address || "__default__";
    if (!this.histories) this.histories = new Map();
    if (!this.histories.has(key)) this.histories.set(key, new PromptHistory());
    return this.histories.get(key);
  }

  attachedFor(address = this.address) {
    if (!address) return [];
    if (!this.attached) this.attached = new Map();
    return this.attached.get(address) ?? [];
  }

  historyKey(dir, cx) {
    const history = this.historyFor(this.address);
    const val = this.box.value();
    const caret = this.box.selected_range?.()?.start ?? val.length;
    const res = dir === "up" ? history.stepUp(val, caret) : history.stepDown(val, caret);
    if (!res.handled) return;
    this.setDraft(res.value);
    this.typed = res.value;
    this.slash = null;
    this.mention = null;
    const pos = dir === "up" && res.value.includes("\n") ? 0 : res.caret;
    try { this.box.set_selected_range({ start: pos, end: pos }); } catch {}
    if (this.address && this.draftStore) this.draftStore.set(this.address, res.value);
    cx.notify();
  }

  // The / menu: Claude's commands/skills or Pi's live bridged commands matching what's typed after "/".
  matches() {
    if (!this.slash || this.menuOff) return [];
    const q = this.slash.q.toLowerCase();
    let all = [];
    if (this.kind === "claude") {
      const known = new Set(COMMANDS.map(([name]) => name));
      all = [...COMMANDS, ...[...this.skills].filter(([name]) => !known.has(name))];
    } else if (this.kind === "pi") {
      const seen = new Set();
      for (const c of this.piMeta?.commands ?? []) {
        const name = String(c?.name ?? "").replace(/^\//, "");
        if (!name || seen.has(name)) continue;
        seen.add(name);
        all.push([name, String(c.description ?? "")]);
      }
    } else {
      return [];
    }
    return [...all.filter(([n]) => n.toLowerCase().startsWith(q)), ...all.filter(([n]) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))].slice(0, 8);
  }

  refreshMentionSources(cx) {
    const cwd = this.agentCwd();
    const homeDir = appHome();
    const staleFiles = this.projectFilesCwd !== cwd || Date.now() - (this.projectFilesAt ?? 0) > 15000;
    cx.spawn(async (cx) => {
      try {
        const imgs = await listRecentImages(homeDir, 20);
        this.recentImages = imgs;
        if (staleFiles && cwd) {
          this.projectFilesCwd = cwd;
          this.projectFilesAt = Date.now();
          this.projectFiles = await scanProjectFiles(cwd, 400, exec);
        }
        cx.notify();
      } catch {}
    });
  }

  mentionMatches() {
    if (!this.mention || this.mentionOff) return [];
    return matchMentions(this.mention.query, this.recentImages ?? [], this.projectFiles ?? [], 8);
  }

  completeMention(item, cx) {
    if (!this.mention || !item) return;
    const span = this.mention;
    const raw = this.box.value();
    // Drop Enter's newline if submit fired right after newline insertion.
    const cleanText = raw.slice(0, span.end) + (raw[span.end] === "\n" ? raw.slice(span.end + 1) : raw.slice(span.end));
    this.mention = null;
    if (item.kind === "image") {
      const applied = applyMention(cleanText, span, "");
      this.setDraft(applied.text);
      try { this.box.set_selected_range({ start: applied.caret, end: applied.caret }); } catch {}
      this.typed = this.box.value();
      this.box.focus();
      const address = this.address;
      if (item.relAsset) {
        this.addAttachedImages(address, [{ absPath: item.absPath, relPath: item.relAsset, name: item.label }], cx);
      } else {
        cx.spawn(async (cx) => {
          try {
            const staged = await stageImageFile(item.absPath, appHome());
            this.addAttachedImages(address, [staged], cx);
          } catch (e) {
            this.note(`Couldn't attach image: ${String(e?.message ?? e).slice(0, 120)}`, cx);
          }
        });
      }
      return;
    }
    const applied = applyMention(cleanText, span, `@${item.insertText} `);
    this.setDraft(applied.text);
    try { this.box.set_selected_range({ start: applied.caret, end: applied.caret }); } catch {}
    this.typed = this.box.value();
    if (this.address && this.draftStore) this.draftStore.set(this.address, this.typed);
    this.box.focus();
  }

  // Puts the picked name in place of the "/word" being typed (Enter's newline dropped), with
  // a space after it, and the caret after that.
  complete(name) {
    const { text, start, end } = this.slash;
    const rest = text.slice(end);
    const head = `${text.slice(0, start)}/${name}${rest.startsWith(" ") ? "" : " "}`;
    this.slash = null;
    this.box.set_value(head + rest);
    this.box.set_selected_range({ start: head.length, end: head.length });
    this.typed = this.box.value();
    this.box.focus();
  }

  // A / or @ menu key (see the bindings in init).
  menuKey(key, cx) {
    const mList = this.mentionMatches();
    if (mList.length) {
      if (key === "down") this.mentionAtIdx = (this.mentionAtIdx + 1) % mList.length;
      else if (key === "up") this.mentionAtIdx = (this.mentionAtIdx + mList.length - 1) % mList.length;
      else if (key === "fill") this.completeMention(mList[this.mentionAtIdx], cx);
      else if (key === "close") this.mentionOff = true;
      else this.mention = null;
      cx.notify();
      return;
    }
    const list = this.matches();
    if (!list.length) return;
    if (key === "down") this.menuAt = (this.menuAt + 1) % list.length;
    else if (key === "up") this.menuAt = (this.menuAt + list.length - 1) % list.length;
    else if (key === "fill") this.complete(list[this.menuAt][0]);
    else if (key === "close") this.menuOff = true;
    else this.slash = null;
    cx.notify();
  }

  // Claude's terminal can be left in one of its own boxes by a stray key (Ctrl+R = "Filter
  // history", seen 2026-11-07: Herdr still says idle, and a send just types into the box, so the
  // chat looked dead). Its footer says "Esc to cancel": press Esc (twice at most) before sending.
  // False = the box is still there, so nothing may be typed.
  async leaveMenu(address, cx) {
    for (let i = 0; i < 3; i++) {
      const r = await hc(["read", address]).catch(() => null);
      if (!boxUp(r?.stdout ?? "")) return true;
      if (i === 2) break;
      await hc(["keys", address, "esc"]);
      await cx.sleep(250);
    }
    return false;
  }

  note(text, cx) {
    this.pasteNote = text;
    cx.notify();
    cx.timer.after(6000, (cx) => { if (this.pasteNote === text) { this.pasteNote = null; cx.notify(); } });
  }

  send(cx) {
    const text = this.box.value().trim();
    if (!this.address || (!text && !this.imageCount(this.address))) return;
    const address = this.address;
    const setDraft = (value) => {
      this.settingDraft = true;
      try { this.box.set_value(value); } finally { this.settingDraft = false; }
    };
    setDraft("");
    this.typed = "";
    this.slash = null;
    this.mention = null;
    if (this.draftStore) this.draftStore.set(address, "");
    // While Claude or Pi asks a structured question, what's typed is the custom answer.
    if (text && ask.typeAnswer(this, text, cx)) { cx.timer.after(600, (cx) => this.tick(cx)); return cx.notify(); }
    if (text) this.historyFor?.(address)?.record(text);
    const hadClaudeInline = this.kind === "claude" && !this.where?.container && (this.images ?? 0) > 0;
    this.images = 0;
    // A dev container's pasted images go as their paths in the container, after the text.
    const containerFiles = this.where?.container ? (this.pasted?.get(address) ?? []) : [];
    this.pasted?.delete(address);
    // Visual attached images (staged under appHome()/pi-images or inline-images).
    const attached = this.attachedFor ? this.attachedFor(address) : [];
    this.attached?.delete(address);
    // For Claude host clipboard-pasted images, Alt+V already injected them into Claude's prompt;
    // only send paths for non-Claude agents or images attached via @mention / drag-drop.
    const pathAttachments = attached
      .filter((img) => this.kind !== "claude" || !img.viaClipboard)
      .map((img) => {
        const winPath = img.absPath.replace(/\//g, "\\");
        return /\s/.test(winPath) ? `"${winPath}"` : winPath;
      });
    const message = [
      text,
      ...containerFiles.map((f) => `[Image: ${f}]`),
      ...pathAttachments,
    ].filter(Boolean).join("\n");
    const idle = !["working", "blocked"].includes(this.target()?.status);
    // Queue tracking & Steer/Cancel UI belong to Claude's native queue.
    if (message && this.kind === "claude" && this.target()?.status === "working") {
      this.queueFor(address).push({ text: message, at: Date.now() });
    }
    cx.spawn(async (cx) => {
      if (idle && !(await this.leaveMenu(address, cx))) {
        if (this.address === address && !this.box.value()) { setDraft(text); this.typed = text; }
        return this.note("The agent's terminal has a box open that Esc didn't close: answer it there first.", cx);
      }
      await hc(message ? ["send", address, message] : (hadClaudeInline ? ["keys", address, "enter"] : ["keys", address, "enter"]));
    });
    if (this.kind === "claude" && OPENS.has(text.slice(1))) this.toTerminal(address);
    if (this.kind !== "claude" && /^\/(model|thinking|settings|resume|login)\s*$/.test(text)) this.toTerminal(address);
    cx.notify();
  }

  menu(t) {
    const mList = this.mentionMatches();
    if (mList.length) {
      return v_flex().p(4).rounded(8).bg(t.popover).border(1).border_color(t.border)
        .children(mList.map((item, i) => h_flex().id(`mention-${i}`).gap(8).px(8).py(5).rounded(6).items_center()
          .cursor_pointer().when(i === this.mentionAtIdx, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.completeMention(item, cx); cx.notify(); })
          .when(item.kind === "image" && Boolean(item.relAsset), (el) => el.child(div().size(24).flex_none().rounded(4).overflow_hidden().bg(t.surface)
            .child(image(item.relAsset).size_full())))
          .when(item.kind === "image" && !item.relAsset, (el) => el.child(div().w(24).flex_none().text_center().text_size(px(11)).text_color(t.accent).child("IMG")))
          .when(item.kind === "file", (el) => el.child(div().w(24).flex_none().text_center().text_size(px(10)).text_color(t.dim).child("FILE")))
          .child(div().max_w(210).flex_none().truncate().font_medium().text_color(t.foreground).child(item.label))
          .child(div().flex_1().min_w(0).truncate().text_size(px(11.5)).text_color(t.dim).child(item.detail))))
        .child(div().px(8).pt(4).text_size(px(10)).text_color(t.dim)
          .child("Enter, Tab or click attaches image / inserts file · @img for images · ↑↓ · Esc"));
    }
    const list = this.matches();
    if (!list.length) return null;
    const opens = (name) => this.kind === "claude" && OPENS.has(name);
    return v_flex().p(4).rounded(8).bg(t.popover).border(1).border_color(t.border)
      .children(list.map(([name, about], i) => h_flex().id(`cmd-${name}`).gap(10).px(8).py(4).rounded(6).items_center()
        .cursor_pointer().when(i === this.menuAt, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.complete(name); cx.notify(); })
        .child(div().w(170).flex_none().truncate().text_color(t.foreground).child(`/${name}`))
        .child(div().flex_1().min_w(0).truncate().text_size(px(12)).text_color(t.dim).child(about))
        .when(opens(name), (el) => el.child(div().flex_none().text_size(px(10)).text_color(t.dim).child("opens in Terminal")))))
      .child(div().px(8).pt(4).text_size(px(10)).text_color(t.dim)
        .child(this.slash.start > 0 ? "Enter, Tab or click fills in · ↑↓ · Esc" : "Enter runs · Tab or click fills in · ↑↓ · Esc"));
  }

  addAttachedImages(address, imgs, cx) {
    if (!address || !imgs?.length) return;
    const prev = this.attachedFor(address);
    const seen = new Set(prev.map((x) => x.absPath.toLowerCase()));
    const next = prev.slice();
    for (const img of imgs) {
      if (!img?.absPath || seen.has(img.absPath.toLowerCase())) continue;
      seen.add(img.absPath.toLowerCase());
      next.push(img);
    }
    this.attached.set(address, next);
    // Keep pi-images shared list in sync so @ and pi-images overlay see them too.
    try {
      const existing = shared("pi-images.list") ?? [];
      const existingNames = new Set(existing.map((x) => x.name));
      const added = imgs
        .filter((x) => x.relPath?.startsWith("pi-images/") && !existingNames.has(x.name))
        .map((x) => ({ name: x.name, at: Date.now() }));
      if (added.length) setShared("pi-images.list", existing.concat(added));
    } catch {}
    cx.notify();
  }

  removeAttachedImage(idx, cx) {
    const address = this.address;
    const list = this.attachedFor(address);
    const removed = list[idx];
    const next = list.filter((_, i) => i !== idx);
    if (next.length) this.attached.set(address, next);
    else this.attached.delete(address);
    if (removed?.viaClipboard && this.kind === "claude" && !this.where?.container) {
      this.images = Math.max(0, (this.images ?? 1) - 1);
      if (this.images === 0) cx.spawn(async () => { await hc(["keys", address, "esc", "esc"]); });
    }
    cx.notify();
  }

  handleDrop(paths, cx) {
    if (!this.address || !paths?.length) return;
    const address = this.address;
    cx.spawn(async (cx) => {
      try {
        const { images, files } = await stageDroppedPaths(paths, appHome());
        if (images.length) this.addAttachedImages(address, images, cx);
        if (files.length && this.address === address) {
          const cwd = this.agentCwd()?.replace(/\\/g, "/").replace(/\/+$/, "");
          const refs = files.map((f) => {
            const norm = f.replace(/\\/g, "/");
            const rel = cwd && norm.toLowerCase().startsWith(`${cwd.toLowerCase()}/`) ? norm.slice(cwd.length + 1) : f;
            return `@${rel}`;
          }).join(" ");
          const cur = this.box.value();
          const joined = cur.trim() ? `${cur.replace(/\s+$/, "")} ${refs} ` : `${refs} `;
          this.setDraft(joined);
          this.typed = this.box.value();
          if (this.draftStore) this.draftStore.set(address, this.typed);
          this.box.focus();
          cx.notify();
        }
      } catch (e) {
        this.note(`Drop failed: ${String(e?.message ?? e).slice(0, 140)}`, cx);
      }
    });
  }

  // Hydrates inline visual thumbnails for any message carrying raw base64 images or image paths.
  hydrateImages(cx) {
    if (this.hydratingImages) return;
    const cwd = this.agentCwd();
    const homeDir = appHome();
    const pending = [];
    for (const item of this.items.slice(-80)) {
      if ((item.kind !== "user" && item.kind !== "claude") || item.imagesHydrated) continue;
      const hasRaw = Array.isArray(item.rawImages) && item.rawImages.length > 0;
      const pathRefs = extractImagePaths(item.text, cwd);
      if (!hasRaw && !pathRefs.length) { item.imagesHydrated = true; continue; }
      pending.push({ item, pathRefs });
    }
    if (!pending.length) return;
    this.hydratingImages = true;
    const epoch = this.epoch;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        for (const { item, pathRefs } of pending) {
          if (this.epoch !== epoch) return;
          const resolved = [];
          const seen = new Set();
          for (const raw of item.rawImages ?? []) {
            try {
              const staged = await cacheBase64Image(raw.data, raw.mimeType, homeDir);
              if (staged && !seen.has(staged.relPath)) { seen.add(staged.relPath); resolved.push(staged); }
            } catch {}
          }
          for (const ref of pathRefs) {
            try {
              const staged = await stageImageFile(ref.absPath, homeDir);
              if (staged && !seen.has(staged.relPath)) { seen.add(staged.relPath); resolved.push(staged); }
            } catch {}
          }
          item.imagesHydrated = true;
          if (resolved.length) {
            item.images = resolved;
            changed = true;
          }
        }
      } finally {
        this.hydratingImages = false;
        if (changed && this.epoch === epoch) cx.notify();
      }
    });
  }

  // A paste with no text (an image): capture clipboard image directly into pi-images/ so it
  // renders immediately as a visual thumbnail in the composer (never bouncing to hidden terminal).
  pasteImage(cx) {
    if (!this.address) return;
    const address = this.address;
    if (this.kind === "claude" && this.where?.container) return this.pasteIntoContainer(address, this.where, cx);
    if (this.kind === "claude") {
      if (this.screen && this.target()?.status !== "blocked") return this.note("Close the box in Claude's terminal first", cx);
      this.images = (this.images ?? 0) + 1;
      cx.spawn(async (cx) => {
        await hc(["keys", address, /^win/.test(os.platform()) ? "alt+v" : "ctrl+v"]);
        if (/^win/.test(os.platform())) {
          const imgs = await captureClipboardImages(appHome(), exec).catch(() => []);
          if (imgs.length && this.address === address) {
            this.addAttachedImages(address, imgs.map((x) => ({ ...x, viaClipboard: true })), cx);
          }
        }
      });
      cx.notify();
      return;
    }
    // Pi / Codex / OpenCode: save clipboard image directly into appHome()/pi-images and show thumbnail.
    this.pasteNote = "Pasting image…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const imgs = await captureClipboardImages(appHome(), exec);
        this.pasteNote = null;
        if (imgs.length) {
          this.addAttachedImages(address, imgs, cx);
        } else {
          this.note("No image found on the clipboard", cx);
        }
      } catch (e) {
        this.pasteNote = null;
        this.note(`Image paste failed: ${String(e?.message ?? e).slice(0, 140)}`, cx);
      }
    });
  }

  // A dev container's Claude runs on Linux with no clipboard (no X or Wayland, no xclip), so its
  // paste key finds nothing. Instead the clipboard image is saved here as a PNG, copied into the
  // container with `docker cp`, and its path goes with the next message (the way Herdr pastes an
  // image into a terminal on another machine). That Claude runs with bypassPermissions, so it
  // reads /tmp without asking. Windows only (the clipboard is read with .NET).
  pasteIntoContainer(address, where, cx) {
    if (!/^win/.test(os.platform())) { this.pasteNote = "Pasting images into a dev container needs Windows"; return cx.notify(); }
    const name = `herdr-paste-${newUuid()}.png`;
    this.pasteNote = "Copying the image into the container…";
    cx.notify();
    cx.spawn(async (cx) => {
      // The clipboard's image, else the first image file copied in Explorer. Exit 3 = no image.
      const r = await exec("powershell", ["-NoProfile", "-STA", "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Windows.Forms, System.Drawing; " +
        `$p = Join-Path $env:TEMP '${name}'; $img = [Windows.Forms.Clipboard]::GetImage(); ` +
        "if (-not $img) { $f = [Windows.Forms.Clipboard]::GetFileDropList() | Where-Object { $_ -match '\\.(png|jpe?g|gif|webp|bmp)$' } | Select-Object -First 1; " +
        "if (-not $f) { exit 3 }; $img = [Drawing.Image]::FromFile($f) }; " +
        "$img.Save($p, [Drawing.Imaging.ImageFormat]::Png); $img.Dispose(); " +
        `docker cp $p '${where.container}:/tmp/${name}'; $c = $LASTEXITCODE; Remove-Item $p; exit $c`])
        .catch((e) => ({ code: -1, stderr: String(e) }));
      if (r.code === 0) {
        this.pasted.set(address, [...(this.pasted.get(address) ?? []), `/tmp/${name}`]);
        this.pasteNote = null;
      } else {
        this.pasteNote = r.code === 3 ? "No image on the clipboard" : `Couldn't copy the image: ${(r.stderr || `exit ${r.code}`).trim().slice(0, 200)}`;
        cx.timer.after(6000, (cx) => { this.pasteNote = null; cx.notify(); });
      }
      cx.notify();
    });
  }

  // How many images wait to go with the next message: attached thumbnails, dev container files, or Claude prompt.
  imageCount(address) {
    const attached = this.attachedFor(address).length;
    if (this.where?.container) return (this.pasted.get(address)?.length ?? 0) + attached;
    return Math.max(this.images ?? 0, attached);
  }

  // Clear pending images for the current agent.
  dropImages(cx) {
    const address = this.address;
    this.attached.delete(address);
    if (this.where?.container) { this.pasted.delete(address); return cx.notify(); }
    if (this.kind === "claude" && (this.images ?? 0) > 0) {
      this.images = 0;
      cx.spawn(async () => { await hc(["keys", address, "esc", "esc"]); });
    } else {
      this.images = 0;
    }
    cx.notify();
  }

  // A copy of this conversation in a new tab of the same space: `claude --resume <id> --fork-session`
  // gives the copy its own session id, so the two go on separately. With `at` (the uuid of a reply)
  // the copy ends at that reply: its lines up to there go to a new session file (`cutCopy`),
  // which is resumed. Not --resume-session-at: print mode honors it, the interactive TUI ignores it
  // (tested 2026-10-31). A dev-container agent's copy starts in the dev container (its sessions
  // are on the shared volume) like the "Claude (dev container)" program does.
  // `forkNote` in the header says it's under way, or why it failed (a cut copy takes a few seconds).
  async fork(agent, at, cx) {
    const session = this.session;
    // The last fork's steps in ~/.config/herdr-app/fork.log, to see where a click got to.
    const log = [`${new Date().toISOString()} fork ${agent?.address} at=${at ?? "end"} session=${session?.sessionId}`];
    const note = (text) => {
      this.forkNote = text; cx.notify();
      log.push(text ?? "opened");
      writeFile(`${home()}/.config/herdr-app/fork.log`, log.join("\n") + "\n").catch(() => {});
    };
    if (!session?.sessionId) return note("Fork: no session yet");
    note("Forking…");
    try {
      const where = this.where;
      const args = at ? ["--resume", await this.cutCopy(where, session, this.file, at)] : ["--resume", session.sessionId, "--fork-session"];
      if (!args[1]) return note(`Fork failed: couldn't copy the conversation${this.forkErr ? ` (${this.forkErr})` : ""}`);
      const name = `${agent.title || "Claude"} (fork)`;
      if (where?.container) {
        run("tab.new", { name, space: agent.space,
          argv: ["cmd.exe", "/c", `devcontainer exec --workspace-folder . claude ${args.join(" ")}`] });
      } else {
        run("tab.new", { name, space: agent.space, folder: session.cwd, argv: ["claude", ...args] });
      }
      note(null);
    } catch (e) {
      note(`Fork failed: ${e?.message ?? e}`);
    } finally {
      if (this.forkNote) cx.timer.after(6000, (cx) => { this.forkNote = null; cx.notify(); });
    }
  }

  // A new session file beside the transcript: its lines up to and including the one with uuid
  // `at`, under a new session id. Returns that id, or null if `at` isn't in the file.
  async cutCopy(where, session, file, at) {
    const id = newUuid();
    const mark = `"uuid":"${at}"`;
    if (where?.container) {
      // $2 transcript, $3 mark, $4 old id, $5 new id, $6 new file (all relative to the Claude folder).
      const out = file.replace(/[^/]+\.jsonl$/, `${id}.jsonl`);
      const r = await inDocker(where, 'n=$(grep -n -m1 -F "$3" "$d/$2" | cut -d: -f1) && [ -n "$n" ] && head -n "$n" "$d/$2" | sed "s/\\"sessionId\\":\\"$4\\"/\\"sessionId\\":\\"$5\\"/g" > "$d/$6" && echo ok',
        file, mark, session.sessionId, id, out);
      return r.stdout.trim() === "ok" ? id : null;
    }
    // Cut in a separate process: doing it here (decode, split, write 16 MB) on Herdr's UI thread
    // got cut off by its time limit and the click did nothing (2026-11-01).
    const dest = file.replace(/[^/\\]+\.jsonl$/, `${id}.jsonl`);
    const old = session.sessionId;
    const r = /^win/.test(os.platform()) // "windows" here, not node's "win32"
      ? await exec("powershell", ["-NoProfile", "-Command",
        `$t = [IO.File]::ReadAllText('${file}'); $i = $t.IndexOf('${mark}'); if ($i -lt 0) { exit 3 }; ` +
        `$e = $t.IndexOf([char]10, $i); if ($e -lt 0) { $e = $t.Length - 1 }; ` +
        `$c = $t.Substring(0, $e + 1).Replace('"sessionId":"${old}"', '"sessionId":"${id}"'); ` +
        `[IO.File]::WriteAllText('${dest}', $c, (New-Object Text.UTF8Encoding $false))`]).catch((e) => ({ code: -1, stderr: String(e) }))
      : await exec("sh", ["-c", 'n=$(grep -n -m1 -F "$2" "$1" | cut -d: -f1) && [ -n "$n" ] && head -n "$n" "$1" | sed "s/\\"sessionId\\":\\"$3\\"/\\"sessionId\\":\\"$4\\"/g" > "$5"',
        "sh", file, mark, old, id, dest]).catch((e) => ({ code: -1, stderr: String(e) }));
    this.forkErr = r.code === 0 ? null : (r.code === 3 ? "message not found in the transcript" : (r.stderr || `exit ${r.code}`).slice(0, 300));
    return r.code === 0 && (await exists(dest)) ? id : null;
  }

  keys(...keys) {
    const address = this.address;
    return (_e, cx) => {
      cx.spawn(async (cx) => { await hc(["keys", address, ...keys]); this.screen = null; this.tick(cx); });
    };
  }

  // ---- drawing

  // Inline visual thumbnails inside chat bubbles; clicking opens the image in file-view.
  imageStrip(t, item, i) {
    const imgs = item.images;
    if (!imgs?.length) return null;
    return h_flex().gap(6).flex_wrap().pt(item.text ? 6 : 0)
      .children(imgs.map((img, k) => div().id(`msg-img-${i}-${k}`).h(80).max_w(160).rounded(8).overflow_hidden()
        .bg(t.surface).border(1).border_color(t.border).cursor_pointer()
        .hover((s) => s.border_color(t.accent))
        .tooltip(`${img.name} — click to open`)
        .on_click((_e, cx) => { cx.stop_propagation(); openInViewer(img.absPath); })
        .child(image(img.relPath).h(80).max_w(160))));
  }

  // Visual thumbnail tray above the composer for pasted, dropped, or @-mentioned images.
  imageTray(t, agent) {
    const attached = this.attachedFor(agent.address);
    const total = this.imageCount(agent.address);
    if (!attached.length && !total) return null;
    if (!attached.length) {
      return h_flex().gap(8).items_center().px(4).text_size(px(12)).text_color(t.muted)
        .child(div().px(8).py(2).rounded(6).bg(t.raised).text_color(t.foreground)
          .child(total === 1 ? "🖼 1 image" : `🖼 ${total} images`))
        .child(div().flex_1().min_w(0).truncate().child(this.where?.container
          ? "copied into the container, sent with your message" : "attached, sent with your message"))
        .when(Boolean(this.where?.container) || agent.status !== "working", (el) => el.child(this.button(t, "drop-images", "Remove", (_e, cx) => this.dropImages(cx))));
    }
    return h_flex().gap(8).items_center().flex_wrap().px(4)
      .children(attached.map((img, idx) => div().id(`tray-img-${idx}`).relative().h(58).max_w(110)
        .rounded(8).overflow_hidden().bg(t.background).border(1).border_color(t.border)
        .tooltip(`${img.name} — click to preview`)
        .child(div().size_full().cursor_pointer().on_click(() => openInViewer(img.absPath))
          .child(image(img.relPath).h(58).max_w(110)))
        .child(div().id(`tray-img-rm-${idx}`).absolute().top(2).right(2).size(18).rounded(9)
          .bg(t.background).border(1).border_color(t.border).flex().items_center().justify_center()
          .text_size(11).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.blocked).text_color(t.solid_foreground))
          .tooltip("Remove image")
          .on_click((_e, cx) => { cx.stop_propagation(); this.removeAttachedImage(idx, cx); })
          .child("×"))))
      .when(attached.length > 1, (el) => el.child(this.button(t, "drop-images", "Clear all", (_e, cx) => this.dropImages(cx))));
  }

  bubbleActions(t, item, i, isUser) {
    if (!item.text) return null;
    const copyId = `bcopy-${i}`, copied = this.copied === copyId;
    const act = (id, label, tip, onClick) => div().id(id).px(5).py(2).rounded(4).text_size(px(10.5))
      .text_color(copied && id === copyId ? t.accent : t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
    return h_flex().flex_none().gap(2).opacity(0.32).hover((s) => s.opacity(1))
      .child(act(copyId, copied ? "✓" : "Copy", "Copy message", (cx) => {
        cx.write_to_clipboard(item.text);
        this.copied = copyId; cx.notify();
        cx.spawn(async (cx) => { await cx.sleep(1500); if (this.copied === copyId) { this.copied = null; cx.notify(); } });
      }))
      .child(act(`bquote-${i}`, "Quote", "Quote in composer", () => this.quote(item.text)))
      .when(isUser, (el) => el.child(act(`bedit-${i}`, "Reuse", "Load into composer", (cx) => {
        this.setDraft(item.text);
        this.typed = item.text;
        this.box.focus();
        cx.notify();
      })));
  }

  bubble(t, item, i) {
    if (item.kind === "user") {
      // Full width on the left: a box like the VS Code extension's, tinted with the accent, or a bar.
      const mine = chatLook().mine;
      const strip = this.imageStrip(t, item, i);
      const actions = this.bubbleActions(t, item, i, true);
      return h_flex().w_full().justify_end().child(v_flex().max_w("78%").px(14).py(10).text_color(t.foreground).line_height(LINE)
        .on_mouse_down("right", (e) => this.ctxHit(e, item))
        .when(mine === "box", (el) => el.rounded(12).bg(fade(t.accent, "1a")).border(1).border_color(fade(t.accent, "40")))
        .when(mine === "tint", (el) => el.rounded(12).bg(fade(t.accent, "26")).border(1).border_color(fade(t.accent, "59")))
        .when(mine === "bar", (el) => el.border_l(3).border_color(t.accent))
        .child(h_flex().gap(8).items_center()
          .when(Boolean(item.text), (el) => el.child(div().min_w(0).child(TextView.markdown(`me-${i}`,
            this.markIn(i) ? plainMarked(item.text, this.marks.re, this.markIn(i)) : plainMarkdown(item.text)).selectable(true))))
          .when(Boolean(item.mid), (el) => el.child(div().flex_none().text_size(px(11)).text_color(t.dim).tooltip("Sent while working; read at next step").child("mid-turn")))
          .when(Boolean(item.before && this.agentNow), (el) => el.child(div().id(`fork-${i}`).flex_none().p(2).rounded(4)
            .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Fork from here: a copy of the conversation up to just before this message, in a new tab")
            .on_click((_e, cx) => { const agent = this.agentNow; cx.spawn(async (cx) => { await this.fork(agent, item.before, cx); }); })
            .child(svg("mods/workspace-chrome/git-branch.svg").size(13)))))
        .when(Boolean(strip), (el) => el.child(strip))
        .when(Boolean(actions), (el) => el.child(h_flex().justify_end().pt(3).child(actions))));
    }
    if (item.kind === "claude") {
      const cwd = this.agentCwd();
      const marked = (md) => { const linked = linkify(md, cwd); return this.markIn(i) ? markMarkdown(linked, this.marks.re, this.markIn(i)) : linked; };
      const onLink = (url, cx) => {
        if (!url.startsWith(OPEN_URL)) return cx.open_url(url);
        const ref = decodeViewerUrl(url);
        openInViewer(ref.path, null, ref.line);
      };
      const parts = codeParts(item);
      const strip = this.imageStrip(t, item, i);
      const actions = this.bubbleActions(t, item, i, false);
      // The first reply after one of your messages starts a turn: label it.
      const prev = typeof i === "number" ? speakerOf(this, i) : null;
      const label = prev?.kind === "user"
        ? h_flex().gap(6).items_center().pb(2).text_size(px(11.5)).font_semibold().text_color(t.accent)
          .child(div().size(8).rounded(4).bg(t.accent)).child(div().flex_1().child(SPEAKERS[this.kind] ?? "Agent"))
          .when(Boolean(actions), (el) => el.child(actions))
        : null;
      const reply = v_flex().w_full().gap(4).line_height(LINE)
        .on_mouse_down("right", (e) => this.ctxHit(e, item))
        .when(Boolean(item.text) && !parts, (el) => el.child(div().w_full().min_w(0).text_color(t.foreground)
          .child(TextView.markdown(`md-${i}`, marked(item.text)).selectable(true).on_link_click(onLink))))
        // With code blocks: a TextView per piece, each block with its copy button on top.
        .when(Boolean(parts), (el) => el.child(v_flex().w_full().min_w(0).gap(8).text_color(t.foreground)
          .children(parts.map((p, k) => {
            const view = TextView.markdown(`md-${i}-${k}`, p.code === undefined ? marked(p.md) : p.md).selectable(true).on_link_click(onLink);
            if (p.code === undefined) return div().w_full().child(view);
            const id = `copy-${i}-${k}`, done = this.copied === id;
            return div().relative().w_full().child(view)
              .child(div().id(id).absolute().top(4).right(4).p(4).rounded(4).bg(t.surface)
                .text_color(done ? t.accent : t.dim).cursor_pointer()
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip(done ? "Copied" : "Copy code")
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(p.code);
                  this.copied = id; cx.notify();
                  cx.spawn(async (cx) => { await cx.sleep(1500); if (this.copied === id) { this.copied = null; cx.notify(); } });
                })
                .child(svg(`mods/workspace-chrome/${done ? "check" : "files"}.svg`).size(12)));
          }))))
        .when(Boolean(strip), (el) => el.child(strip))
        .when(!label && Boolean(actions), (el) => el.child(h_flex().justify_end().child(actions)));
      return label ? v_flex().w_full().pt(6).child(label).child(reply) : reply;
    }
    if (item.kind === "thinking") return this.thinkingRow(t, item, i);
    if (item.kind === "note") {
      return div().w_full().px(10).py(4).text_size(px(12)).text_color(t.dim)
        .when(Boolean(item.mono), (el) => el.font_family(this.mono()).rounded(6).bg(t.surface).child(clip(item.text, 1500)))
        .when(!item.mono, (el) => el.flex().justify_center().child(`— ${item.text} —`));
    }
    if (AGENT_TOOLS.has(item.name)) return this.subCard(t, item, i);
    if (ask.isQuestionTool(item.name)) return ask.asked(t, px, item);
    return this.tool(t, item, i);
  }

  // What the agent thought: a purple block. The newest one is open (and spins while it's the
  // last thing the agent did); older ones fold to their first line. Click flips either.
  thinkingRow(t, item, i) {
    const tint = t.ansi5;
    const key = `th-${i}`;
    const newest = typeof i === "number" && i === this.lastThinking;
    const live = newest && this.agentWorking && i === this.items.length - 1;
    const open = newest ? !this.open.has(`${key}:closed`) : this.open.has(key);
    const words = item.text.split(/\s+/).filter(Boolean).length;
    const first = item.text.replace(/[*_#`]/g, "").split("\n").find((l) => l.trim())?.trim() ?? "";
    return v_flex().w_full().pl(16)
      .child(h_flex().id(key).gap(8).items_center().py(2).px(6).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { const k = newest ? `${key}:closed` : key; this.open.has(k) ? this.open.delete(k) : this.open.add(k); cx.notify(); })
        .child(h_flex().w(12).flex_none().justify_center()
          .child(live ? div().text_size(px(12)).text_color(tint).when(shared("p5.motion") !== false, (el) => el.frames(THINK_SPIN, 90)).child(THINK_SPIN[0]) : div().size(7).rounded(4).bg(tint)))
        .child(div().flex_none().font_semibold().text_size(px(12)).text_color(tint).child(live ? "Thinking…" : "Thought"))
        .child(div().flex_1().min_w(0).truncate().text_size(px(12)).text_color(t.dim).child(open ? `${words} words` : first))
        .child(div().flex_none().text_size(px(10)).text_color(t.dim).child(open ? "▾" : "▸")))
      .when(open, (el) => el.child(div().ml(26).mt(2).mb(4).px(12).py(10).rounded(8).bg(fade(tint, "14"))
        .border_l(3).border_color(tint).line_height(LINE).text_size(px(13.5))
        .child(TextView.markdown(`think-${i}`, item.text).selectable(true))));
  }

  // A sub-agent: its type, task and model, and how far it got. Click opens its conversation.
  subCard(t, item, i) {
    const sub = this.subs.get(item.id);
    const input = item.input ?? {};
    // A background one's call returns at once ("Async agent launched…"); only its meta says when it's done.
    const background = /^Async agent launched/.test(item.result ?? "");
    const state = item.error ? "failed" : (sub ? sub.finished : item.result !== undefined && !background) ? "done" : "working";
    const steps = sub ? sub.items.filter((x) => x.kind === "tool") : [];
    const last = steps[steps.length - 1];
    const count = `${steps.length} ${steps.length === 1 ? "tool" : "tools"}`;
    const line = state === "failed" ? (item.result ?? "").split("\n")[0]
      : state === "done" ? (sub ? `Done · ${count}` : "Done")
      : last ? `${count} · ${last.name} ${toolLine(last.name, last.input)}` : "Starting…";
    const mark = state === "working"
      ? spinning(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working), 900)
      : div().size(7).rounded(4).bg(state === "failed" ? t.blocked : t.done);
    const model = sub?.model ?? input.model;
    return v_flex().w_full().pl(16)
      .child(v_flex().id(`agent-${i}`).gap(4).px(10).py(8).rounded(8).bg(t.surface).border(1)
        .border_color(state === "failed" ? t.blocked : t.border)
        .when(Boolean(sub), (el) => el.cursor_pointer().hover((s) => s.border_color(t.accent))
          .on_click((_e, cx) => { this.trail.push(item.id); this.up = 0; this.limit = PAGE; cx.notify(); }))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().font_semibold().text_size(px(12)).text_color(t.foreground).child(sub?.type ?? input.subagent_type ?? "Agent"))
          .child(div().flex_1().min_w(0).truncate().text_size(px(12)).text_color(t.muted).child(input.description ?? ""))
          .when(Boolean(model), (el) => el.child(div().flex_none().text_size(px(10.5)).text_color(t.dim).child(model))))
        .child(h_flex().gap(8).items_center()
          .child(h_flex().w(12).flex_none().justify_center().child(mark))
          .child(div().flex_1().min_w(0).truncate().text_size(px(11.5)).text_color(t.dim).child(line))
          .when(Boolean(sub), (el) => el.child(div().flex_none().text_size(px(11.5)).text_color(t.accent).child("Open ›")))));
  }

  // The chat cut at each of your messages. The last turn is all open; in each earlier one your
  // message and Claude's last reply stay, and the work between them (tool calls, messages along
  // the way) is one row until clicked open, so scrolling up reads like the conversation and a
  // redraw builds less markdown.
  turns(all, visible) {
    const turns = [];
    for (const entry of all) {
      if (entry[0].kind === "user" || !turns.length) turns.push([]);
      turns.at(-1).push(entry);
    }
    return turns.flatMap((turn, n) => {
      if (n === turns.length - 1) return turn.filter(visible);
      const from = turn[0][0].kind === "user" ? 1 : 0;
      let to = turn.findLastIndex(([x]) => x.kind === "claude");
      // No reply (interrupted): all of it is work.
      if (to < from) to = turn.length;
      const work = turn.slice(from, to);
      if (!work.length) return turn.filter(visible);
      const key = `${this.address}:${turn[0][1]}`;
      const open = this.unfolded.has(key);
      return [...turn.slice(0, from), { work, key, open }, ...(open ? work.filter(visible) : []), ...turn.slice(to).filter(visible)];
    });
  }

  // The row standing for a turn's work, like a tool row: "▸ 12 tools · 3 messages".
  turnRow(t, { work, key, open }, found) {
    const count = (kind, one, many) => {
      const n = work.filter(([x]) => x.kind === kind).length;
      return n ? `${n} ${n === 1 ? one : many}` : null;
    };
    // Search hits folded away in it.
    const hits = !open && found.size ? work.filter(([, id]) => found.has(id)).length : 0;
    const about = [count("tool", "tool", "tools"), count("claude", "message", "messages")].filter(Boolean).join(" · ") || `${work.length} more`;
    return v_flex().w_full().pl(16)
      .child(h_flex().id(`turn-${key}`).gap(8).items_center().py(2).px(6).rounded(6).cursor_pointer()
        .text_size(px(12)).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        // The row stays where it is and the work opens below it (see log's on_size_change).
        .on_click((_e, cx) => { open ? this.unfolded.delete(key) : this.unfolded.add(key); this.holdTop = true; cx.notify(); })
        .child(h_flex().w(12).flex_none().justify_center().text_size(px(10)).child(open ? "▾" : "▸"))
        .child(div().flex_1().min_w(0).truncate().child(open ? `Fold ${about}` : about))
        .when(hits > 0, (el) => el.child(div().flex_none().text_color(t.accent).child(hits === 1 ? "1 match" : `${hits} matches`))));
  }

  // Alt+← (like a browser), or Esc while the agent isn't working and no menu is open, leaves an
  // opened sub-agent for the one that started it, or the main chat. (Mods get no mouse back button.)
  subKey(e, status, menu, cx) {
    if (!this.trail.length) return false;
    if (e.keystroke !== "alt-left" && !(e.keystroke === "escape" && status !== "working" && !menu)) return false;
    cx.stop_propagation();
    this.subBack(cx);
    return true;
  }

  subBack(cx) {
    this.trail.pop(); this.up = 0; this.limit = PAGE; cx.notify();
  }

  // The bar over an opened sub-agent's conversation: back to the chat (or the sub-agent that started it).
  subBar(t, sub) {
    const parent = this.trail.length > 1 ? this.subs.get(this.trail[this.trail.length - 2]) : null;
    const where = this.trail.length > 1 ? `Back to ${parent?.type ?? "parent agent"}` : "Back to main chat";
    return h_flex().h(40).flex_none().text_size(12).px(10).gap(10).items_center().border_b(1).border_color(t.border).bg(t.surface)
      .child(h_flex().id("sub-back").flex_none().h(28).px(12).gap(6).items_center().rounded(7).cursor_pointer()
        .bg(t.accent).text_color(t.accent_foreground).font_semibold().text_size(12.5)
        .hover((s) => s.opacity(0.85))
        .on_click((_e, cx) => this.subBack(cx))
        .child(`← ${where}`)
        .child(div().text_size(10.5).opacity(0.75).child("Alt+←")))
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(sub.type ?? "Agent"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(sub.about ?? ""))
      .when(Boolean(sub.model), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(sub.model)))
      .child(div().flex_none().text_size(11).text_color(sub.finished ? t.done : t.working).child(sub.finished ? "done" : "working"));
  }

  // The shown agent's sub-agents at work, over the box; click one to open it.
  // ---- queued messages (sent while Claude works)

  // A message sent while Claude works (Enter, here or in its terminal) goes into Claude's queue
  // and reaches it at its next step, inside a reminder (`mid` messages in said; "absorbed" in
  // the transcript), or when the turn ends (ctrl+x enter queues it until then). Claude logs the
  // queue in the transcript as queue-operation lines (enqueue; dequeue / remove when taken), so
  // those drive the list (queueOp); a send from here is listed at once and matched to its
  // enqueue. Shown dimmed at the bottom of the log. Per agent, kept across switches.
  queueFor(address) {
    this.queues ??= new Map();
    if (!this.queues.has(address)) this.queues.set(address, []);
    return this.queues.get(address);
  }

  queueOp(line) {
    let d;
    try { d = JSON.parse(line); } catch { return; }
    const text = typeof d.content === "string" ? d.content.trim() : "";
    const list = this.queueFor(this.address);
    const at = Date.parse(d.timestamp) || Date.now();
    // A background task's notice goes through the same queue (enqueue, then a dequeue with no
    // text, mid-turn): not a message of yours, and its dequeue isn't the turn taking the queue.
    this.queueNotes ??= new Map();
    const notes = this.queueNotes.get(this.address) ?? 0;
    if (text.startsWith("<task-notification>")) {
      if (d.operation === "enqueue" && Date.now() - at < 3600000) this.queueNotes.set(this.address, notes + 1);
      else if (notes) this.queueNotes.set(this.address, notes - 1);
      return;
    }
    if (!text && d.operation !== "enqueue" && notes) return void this.queueNotes.set(this.address, notes - 1);
    if (!text) {
      // A dequeue at the turn's end names no message: Claude took the whole queue as its next
      // prompt (seen 2026-11-09: the rows stayed, and Cancel on one re-sent a taken message).
      if (d.operation !== "enqueue" && list.length) { list.length = 0; this.version = (this.version ?? 0) + 1; }
      return;
    }
    if (d.operation === "enqueue") {
      // Old lines are read on load too: their enqueues are long taken (or lost).
      if (Date.now() - at > 3600000) return;
      const mine = list.find((q) => q.text === text && !q.logged);
      if (mine) Object.assign(mine, { logged: true, at });
      else list.push({ text, at, logged: true });
    } else {
      const i = list.findIndex((q) => q.text === text);
      if (i >= 0) list.splice(i, 1);
    }
    this.version = (this.version ?? 0) + 1;
  }

  // The agent's queued messages still waiting: one the transcript shows delivered (its text, on
  // its own or joined with others) is gone, and so is any left when the agent stopped working
  // for 5 s (edited away in the terminal; a remove line should have come).
  queuedNow(agent) {
    const list = this.queues?.get(agent.address);
    if (!list?.length) return [];
    const recent = this.items.slice(-40).filter((x) => x.kind === "user").map((x) => x.text);
    const now = Date.now();
    // Only for one Claude's log hasn't named yet: a logged one goes by its remove / dequeue line
    // (a queued "cancel" was hidden because an earlier message held the word, and a Cancel on
    // the row beside it then dropped both; 2026-11-13).
    const kept = list.filter((q) => !(!q.logged && recent.some((u) => u.includes(q.text)))
      && (agent.status === "working" || now - q.at < 5000) && !(q.acting && now - q.acting > 8000));
    if (kept.length !== list.length) this.queues.set(agent.address, kept);
    return kept;
  }

  // Up in Claude's empty prompt takes every queued message back into the prompt (one popAll line
  // each, joined by line breaks). The prompt is then emptied a line at a time, ctrl+u (clears
  // the cursor's line; the cursor is at the end) then backspace (joins the line above), until
  // the screen shows it empty. Not ctrl+c: on 2.1.318 it emptied a filled prompt, on 2.1.323 it
  // interrupts the turn and leaves the text (2026-11-13; ctrl+l and Esc did nothing on 2.1.318).
  // Then the messages to keep are sent again, in order (Enter while Claude works queues them
  // again), the one to deliver first, followed by ctrl+enter (Claude's chat:sendNow: the
  // transcript logs it removed, "absorbed_mid_turn"). Only what Up really brought back is sent
  // again. It starts only while the prompt says "Press up to edit queued messages": without a
  // queue (the turn just took it) Up browses history instead, and the last entry is the very
  // message Claude just took. Returns why nothing was done, or null.
  async requeue(agent, keep, first, cx) {
    const t = agent.address;
    const log = [`${new Date().toISOString()} requeue ${t} first=${JSON.stringify(first)} keep=${JSON.stringify(keep)}`];
    const done = (why) => {
      log.push(why ?? "done");
      writeFile(`${appHome()}/queue.log`, log.join("\n") + "\n").catch(() => {});
      return why;
    };
    const prompt = async () => promptText((await hc(["read", t]).catch(() => null))?.stdout ?? "");
    const before = await prompt();
    log.push(`before: ${JSON.stringify(before.slice(0, 80))}`);
    if (!QUEUE_HINT.test(before)) return done("Claude's terminal no longer shows queued messages: nothing changed.");
    await hc(["keys", t, "up"]);
    // The screen lags the key: read right after Up it still showed the hint (2026-11-09).
    let held = before;
    for (let i = 0; i < 5 && QUEUE_HINT.test(held); i++) {
      await cx.sleep(300);
      held = await prompt();
      log.push(`read ${i}: ${JSON.stringify(held.slice(0, 80))}`);
    }
    if (QUEUE_HINT.test(held)) return done("Claude's terminal didn't give its queued messages back: nothing changed.");
    let left = held;
    for (let i = 0; i < 6 && left; i++) {
      const lines = left.split("\n").length + 1;
      await hc(["keys", t, ...Array.from({ length: lines }, () => ["ctrl+u", "backspace"]).flat()]);
      await cx.sleep(300);
      left = await prompt();
      log.push(`cleared ${i}: ${JSON.stringify(left.slice(0, 80))}`);
    }
    if (left) return done("Couldn't empty Claude's prompt: the queued messages are in it, in its terminal.");
    // The screen wraps long lines, so compare without spaces.
    const squash = (x) => x.replace(/\s+/g, "");
    const got = squash(held);
    // Claude folds a long paste to "[Pasted text #1 +19 lines]": the texts can't be checked
    // then, and Up took the whole queue (the hint was there), so all are sent again.
    const folded = /\[Pasted text #\d+/.test(held);
    const lost = [];
    const send = async (text) => {
      // Not on the screen: not sent blind, kept for the box.
      if (!folded && !got.includes(squash(text))) { lost.push(text); return log.push(`not popped: ${JSON.stringify(text.slice(0, 80))}`); }
      const r = await hc(["send", t, text]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code) { lost.push(text); log.push(`send failed: ${(r.stderr || "").trim().slice(0, 200)}`); }
      return !r.code;
    };
    if (first && (await send(first)) === true) {
      await hc(["keys", t, "ctrl+enter"]);
      // Claude delivers a moment later (1.4 s seen: it moves a running command to the background
      // first), and takes everything queued by then: the others wait until the hint is gone.
      for (let i = 0; i < 20; i++) {
        await cx.sleep(300);
        if (!QUEUE_HINT.test(await prompt())) break;
        if (i === 19) log.push("still queued 6 s after ctrl+enter");
      }
    }
    for (const text of keep) await send(text);
    if (lost.length) {
      // Not seen in the prompt, or Claude stopped taking messages (a permission prompt): back
      // into the box, not lost.
      if (this.address === t && !this.box.value()) { this.setDraft(lost.join("\n\n")); this.typed = this.box.value(); }
      return done("Some queued messages couldn't be sent again (is Claude asking something?): they are in the box.");
    }
    return done(null);
  }

  // `work` gets the task's own cx: only that one has sleep (the click's has none, so the first
  // Cancel in the window stopped right after Up, the message left in Claude's prompt; 2026-11-13).
  // A row's button: every row shows "…" while the keys run; a refusal brings the buttons back.
  actOnQueue(agent, cx, work) {
    const list = this.queueFor(agent.address);
    for (const x of list) x.acting ??= Date.now();
    cx.spawn(async (cx) => {
      const why = await work(list, cx).catch((e) => String(e?.message ?? e));
      if (!why) return;
      for (const x of this.queueFor(agent.address)) delete x.acting;
      this.note(why, cx);
    });
    cx.notify();
  }

  sendNow(agent, q, cx) {
    this.actOnQueue(agent, cx, async (list, cx) => {
      const others = list.filter((x) => x !== q).map((x) => x.text);
      if (others.length) return this.requeue(agent, others, q.text, cx);
      await hc(["keys", agent.address, "ctrl+enter"]);
      return null;
    });
  }

  cancelQueued(agent, q, cx) {
    this.actOnQueue(agent, cx, (list, cx) => this.requeue(agent, list.filter((x) => x !== q).map((x) => x.text), null, cx));
  }

  queuedRow(t, q, k, agent) {
    const speaker = SPEAKERS[this.kind] ?? "Agent";
    const claudeQueue = this.kind === "claude";
    return div().id(`queued-${k}`).w_full().px(12).py(8).rounded(8).border(1).border_color(fade(t.accent, "40"))
      .bg(fade(t.accent, "0d")).text_color(t.muted)
      .child(div().child(TextView.markdown(`queued-text-${k}`, plainMarkdown(q.text)).selectable(true)))
      .child(h_flex().mt(6).gap(10).items_center().text_size(px(11.5)).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(q.acting ? "…" : `Queued · ${speaker} reads it at its next step, or when this turn ends`))
        .when(claudeQueue && !q.acting, (el) => el
          .child(this.button(t, `cancel-queued-${k}`, "Cancel", (_e, cx) => this.cancelQueued(agent, q, cx))
            .tooltip("Take it out of Claude's queue (the others stay queued)"))
          .child(this.button(t, `send-now-${k}`, "Send now", (_e, cx) => this.sendNow(agent, q, cx))
            .tooltip("Give this one to Claude right away (the others stay queued)"))));
  }

  subChips(t) {
    const list = [...this.subs].filter(([id, s]) => subRunning(s, this.tools.get(id)));
    if (!list.length) return null;
    const open = this.trail[this.trail.length - 1];
    return h_flex().gap(6).items_center().flex_wrap().px(4).text_size(px(11.5))
      .child(div().flex_none().text_color(t.muted).child(list.length === 1 ? "1 sub-agent working" : `${list.length} sub-agents working`))
      .children(list.map(([id, s]) => h_flex().id(`chip-${s.name}`).gap(6).items_center().max_w(300).px(8).py(2).rounded(6)
        .cursor_pointer().bg(id === open ? t.selected : t.raised).text_color(t.foreground).hover((x) => x.opacity(0.85))
        .on_click((_e, cx) => { this.trail = [id]; this.up = 0; this.limit = PAGE; cx.notify(); })
        .child(spinning(svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().text_color(t.working), 900))
        .child(div().min_w(0).truncate().child(`${s.type ?? "Agent"} · ${s.about ?? ""}`))));
  }

  // The agent's folder: relative paths in its replies resolve against it.
  agentCwd() {
    return panes().find((p) => p.terminal === this.address)?.cwd ?? null;
  }

  // The file a tool call wrote, edited or read, when it names one (absolute path).
  toolFile(item) {
    if (!/write|edit|read|create|patch|view/i.test(item.name ?? "")) return null;
    const p = item.input?.file_path ?? item.input?.path ?? item.input?.filePath ?? item.input?.notebook_path;
    return typeof p === "string" && p.trim() ? resolvePath(p.trim(), this.agentCwd()) : null;
  }

  tool(t, item, i) {
    const open = this.open.has(item.id);
    const pending = item.result === undefined;
    // From render (agents() per row was a host call for each of up to PAGE rows).
    const working = pending && this.agentWorking;
    const diff = diffOf(item);
    const mark = pending
      ? (working ? spinning(svg("mods/workspace-chrome/spinner.svg").size(11).text_color(t.working), 900) : div().size(7).rounded(4).bg(t.dim))
      : div().size(7).rounded(4).bg(item.error ? t.blocked : t.done);
    return v_flex().w_full().pl(16)
      .child(h_flex().id(`tool-${i}`).gap(8).items_center().py(2).px(6).rounded(6).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { open ? this.open.delete(item.id) : this.open.add(item.id); cx.notify(); })
        .child(h_flex().w(12).flex_none().justify_center().child(mark))
        .child(div().flex_none().font_semibold().text_size(px(12)).text_color(t.muted).child(item.name))
        .child(div().flex_1().min_w(0).truncate().text_size(px(12)).text_color(t.dim).child(toolLine(item.name, item.input)))
        .when(Boolean(diff), (el) => el
          .when(diff.add > 0, (el) => el.child(div().flex_none().text_size(px(11)).text_color("#56D364").child(`+${diff.add}`)))
          .when(diff.del > 0, (el) => el.child(div().flex_none().text_size(px(11)).text_color("#FF7B72").child(`−${diff.del}`))))
        .when(Boolean(this.toolFile(item)), (el) => el.child(div().id(`tool-open-${i}`).flex_none().px(6).rounded(4)
          .text_size(px(11)).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip("Open in the side panel")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); openInViewer(this.toolFile(item), diffOf(item)?.rows ?? null); })
          .child("open ↗")))
        .child(div().flex_none().text_size(px(10)).text_color(t.dim).child(open ? "▾" : "▸")))
      .when(open && Boolean(diff), (el) => el.child(this.diffView(t, item, diff)))
      .when(open && !diff, (el) => el.child(v_flex().ml(26).mt(2).mb(4).p(8).gap(6).rounded(6).bg(t.surface)
        .border(1).border_color(t.border).font_family(this.mono()).text_size(px(11))
        .child(div().text_color(t.muted).child(clip(toolDetail(item.input))))
        .when(!pending, (el) => el.child(div().pt(6).border_t(1).border_color(t.border)
          .text_color(item.error ? t.blocked : t.foreground).child(item.result || "(no output)")))));
  }

  // An Edit's / Write's change: the file, then one row per line, a gutter of new-file line
  // numbers (old ones on removed lines), red for removed, green for added, ⋯ between hunks.
  diffView(t, item, diff) {
    const wide = Math.max(2, ...diff.rows.map((r) => String(r.num ?? "").length));
    const tint = { "+": "#2EA04338", "-": "#F8514938" };
    const ink = { "+": "#56D364", "-": "#FF7B72", " ": t.dim };
    const textInk = { "+": "#E6FFEC", "-": "#FFDCD7", " ": t.foreground };
    const row = (r) => r.kind === "gap"
      ? div().px(8).text_color(t.dim).child("⋯")
      : h_flex().items_start().when(r.kind !== " ", (el) => el.bg(tint[r.kind]))
        .child(div().flex_none().w(wide * px(7) + 10).pr(6).text_right().text_color(ink[r.kind]).child(r.num === undefined ? "" : String(r.num)))
        .child(div().flex_none().w(14).font_semibold().text_color(ink[r.kind]).child(r.kind === " " ? "" : r.kind))
        .child(div().flex_1().min_w(0).pr(8).text_color(textInk[r.kind]).child(r.text || " "));
    return v_flex().ml(26).mt(2).mb(4).rounded(6).overflow_hidden().bg(t.surface).border(1).border_color(t.border)
      .font_family(this.mono()).text_size(px(11))
      .child(div().px(8).py(4).border_b(1).border_color(t.border).text_color(t.muted).truncate().child(diff.path ?? item.name))
      .child(v_flex().py(4).children(diff.rows.map(row)))
      .when(diff.more > 0, (el) => el.child(div().px(8).pb(4).text_color(t.dim).child(`… ${diff.more} more lines`)))
      .when(item.error, (el) => el.child(div().p(8).border_t(1).border_color(t.border).text_color(t.blocked).child(item.result || "(failed)")));
  }

  mono() { return settings().font_family ?? settings().font ?? "JetBrains Mono"; }

  button(t, id, label, onClick, strong) {
    return div().id(id).px(10).py(4).rounded(6).text_size(px(12)).cursor_pointer()
      .bg(strong ? t.solid : t.raised).text_color(strong ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85))
      .on_click(onClick)
      .child(label);
  }

  status(t, agent) {
    const speaker = (typeof SPEAKERS !== "undefined" && SPEAKERS[this.kind]) || "Claude";
    const pendingQuestion = ask.pending?.(this.items) ?? null;
    // A box of the agent's own while Herdr says idle or done (boxText): shown like a blocked prompt.
    const box = agent.status !== "working" && agent.status !== "blocked" && !pendingQuestion && Boolean(this.screen);
    if (agent.status === "blocked" || pendingQuestion || box) {
      // Structured question card for both Claude (AskUserQuestion) and Pi (ask_user_choice / ask_user_question / plan_mode_question).
      const asking = box ? null : ask.card(this, t, px);
      if (asking) return asking;
      if (!box && agent.status !== "blocked") return null;
      const screen = this.screen ?? "";
      const foot = screen.split("\n").slice(-3).join(" ");
      const fallback = ask.detectFallbackKeys
        ? ask.detectFallbackKeys(screen, this.kind)
        : [[...(!screen || /^\s*(❯\s*)?1\.\s/m.test(screen) ? ["1", "2", "3"] : ["up", "down"])].map((k) => [k, k]), ["Enter", "enter"], ["Esc", "esc"]].flat();
      const navKeys = /[←→]/.test(foot) ? [...fallback.slice(0, -2), ["←", "left"], ["→", "right"], ...fallback.slice(-2)] : fallback;
      return v_flex().gap(8).p(10).rounded(8).bg(t.surface).border(1).border_color(t.blocked)
        .child(h_flex().gap(8).items_center()
          .child(div().size(8).rounded(4).bg(t.blocked).when(shared("p5.motion") !== false, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
          .child(div().font_semibold().text_color(t.foreground).child(box ? `${speaker}'s terminal is showing this` : `${speaker} is asking`))
          .when(box, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(px(11)).text_color(t.dim)
            .child("Sending a message closes it first (Esc)"))))
        .when(Boolean(this.screen), (el) => el.child(div().p(8).rounded(6).bg(t.background).text_size(px(11))
          .font_family(this.mono()).text_color(t.foreground).child(this.screen)))
        .child(h_flex().gap(6).flex_wrap()
          .children(navKeys.map(([lbl, k]) => this.button(t, `key-${k}`, lbl, this.keys(k), k === "1" || k === "enter")))
          .child(div().flex_1())
          .child(this.button(t, "to-terminal", "Open terminal", () => this.toTerminal(agent.address))));
    }
    if (agent.status !== "working") return null;
    const report = terminals().find((x) => x.address === agent.address)?.report;
    const msg = typeof report === "object" ? report?.msg : null;
    return h_flex().gap(8).items_center().px(4).text_size(px(12)).text_color(t.muted)
      .child(spinning(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working), 900))
      .child(div().flex_1().min_w(0).truncate().child(this.stuck ? `Still working: Esc only stops ${speaker}'s own turn, not a background task. Stop that in the terminal.` : msg || "Working…"))
      .when(!this.stuck, (el) => el.child(this.button(t, "stop", "Stop", (_e, cx) => this.stop(cx))));
  }

  // The Stop button, and Esc in the chat while Claude works (bound in init; the find bar and the
  // / menu take their own Esc first). Esc, not `hc interrupt`: that presses Ctrl+C for Claude,
  // and a second one quits it.
  stop(cx) {
    const address = this.address;
    cx.spawn(async () => { await hc(["keys", address, "esc"]); });
    cx.timer.after(3000, (cx) => {
      const still = agents().find((a) => a.address === address)?.status === "working";
      if (!still || this.address !== address) return;
      this.stuck = true;
      cx.notify();
      cx.timer.after(8000, (cx) => { this.stuck = false; cx.notify(); });
    });
  }

  piCommandsRoute(address) {
    if (this.kind !== "pi" || this.address !== address) return null;
    const key = `pi-command-palette-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.piCommandRoute = { key, address, epoch: this.epoch };
    return key;
  }

  currentPiCommandRoute(route) {
    return Boolean(route && this.kind === "pi" && this.address === route.address && this.epoch === route.epoch
      && this.showing() && this.target()?.address === route.address);
  }

  openPiCommands(key, cx) {
    const route = this.piCommandRoute;
    if (route?.key !== key || !this.currentPiCommandRoute(route)) return;
    this.piCommandRoute = null;
    this.piCommandOpen = route;
    cx.notify();
  }

  piCommandCatalog() {
    const meta = this.piCommandMeta;
    const now = Date.now();
    if (!meta?.id || !meta.pane || !Number.isSafeInteger(meta.pid) || meta.pid <= 0
      || !Number.isFinite(meta.updated) || meta.updated > now + 1000 || now - meta.updated > 35000
      || !Array.isArray(meta.commands) || meta.commands.length > 1024) return null;
    // Native controls are not exposed by Pi's extension command catalog. Reserve their names
    // even if a template collides, and only stage entries with a known expansion source.
    const native = new Set(["clear", "compact", "copy", "exit", "export", "fork", "help", "hotkeys", "import", "login", "logout", "model", "name", "new", "quit", "reload", "resume", "scoped-models", "session", "settings", "share", "thinking", "tree"]);
    const items = new Map();
    for (const command of meta.commands) {
      if (typeof command?.name !== "string" || command.name.length > 97) continue;
      const name = command.name.replace(/^\//, "");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(name)) continue;
      const selectable = !native.has(name.toLowerCase()) && (command.source === "prompt" || command.source === "skill");
      if (items.has(name)) {
        items.get(name).selectable &&= selectable;
        continue;
      }
      const description = typeof command.description === "string"
        ? command.description.slice(0, 256).replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 144) : "";
      items.set(name, { name, description, selectable });
    }
    return { session: meta.id, pane: meta.pane, pid: meta.pid, entries: [...items.values()] };
  }

  stagePiCommand(route, expected, name, cx) {
    if (this.piCommandOpen !== route || !this.currentPiCommandRoute(route)
      || this.box.value() !== "" || this.imageCount(route.address)) return;
    const current = this.piCommandCatalog();
    if (!current || current.session !== expected.session || current.pane !== expected.pane || current.pid !== expected.pid
      || !current.entries.some((entry) => entry.name === name && entry.selectable)) return;
    const value = `/${name} `;
    this.piCommandOpen = null;
    this.setDraft(value);
    this.typed = value;
    this.slash = null; this.mention = null;
    this.draftStore?.set(route.address, value);
    this.box.set_selected_range?.({ start: value.length, end: value.length });
    this.box.focus();
    cx.notify();
  }

  piCommandsMenu(t) {
    const route = this.piCommandOpen;
    if (!this.currentPiCommandRoute(route)) return null;
    const catalog = this.piCommandCatalog();
    const occupied = this.box.value() !== "" || this.imageCount(route.address) > 0;
    const hint = !catalog ? "Command list unavailable for this Pi session."
      : !catalog.entries.length ? "No commands published by this Pi session."
      : occupied ? "Clear or send your draft and attachments to insert a command."
      : "Choose a command to insert it without sending. Native terminal commands cannot run here.";
    return v_flex().id("pi-command-palette").flex_none().p(8).gap(4).rounded(8).bg(t.popover).border(1).border_color(t.border)
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().text_color(t.foreground).child("Pi commands"))
        .child(this.button(t, "pi-command-close", "Close", (_e, cx) => {
          if (this.piCommandOpen === route) { this.piCommandOpen = null; cx.notify(); }
        })))
      .child(div().text_size(11).text_color(t.dim).child(hint))
      .when(Boolean(catalog?.entries.length), (el) => el.child(v_flex().id("pi-command-list").h(Math.min(216, catalog.entries.length * 29)).overflow_y_scrollbar()
        .children(catalog.entries.map(({ name, description, selectable }) => {
          const row = h_flex().id(`pi-command-${name}`).flex_none().h(29).px(6).gap(8).items_center().rounded(5)
            .text_size(12).text_color(selectable && !occupied ? t.foreground : t.dim)
            .child(div().flex_none().child(`/${name}`))
            .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(description))
            .when(!selectable, (r) => r.child(div().flex_none().text_size(10).child("Not insertable")));
          if (selectable && !occupied) row.cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.stagePiCommand(route, catalog, name, cx));
          return row;
        }))));
  }

  // The ⚙ popup: the chat's look (see LOOK). Every chat follows it at once.
  settingsMenu(t) {
    const look = chatLook();
    const agent = { address: props()?.terminal, label: props()?.agentName };
    const kind = props()?.agentKind;
    const seg = (key, value, label) => div().id(`look-${key}-${value}`).px(8).h(22).flex().items_center().rounded(5)
      .text_size(12).cursor_pointer()
      .when(look[key] === value, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(look[key] !== value, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
      .on_click(() => setLook({ [key]: value }))
      .child(label);
    const pills = (...segs) => h_flex().flex_none().p(2).gap(2).rounded(7).bg(t.surface).border(1).border_color(t.border).children(segs);
    const row = (label, control) => h_flex().h(34).px(8).gap(8).items_center()
      .child(div().flex_1().text_color(t.foreground).child(label)).child(control);
    const step = (id, label, by) => div().id(id).size(24).flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click(() => setLook({ size: Math.max(10, Math.min(22, look.size + by)) }))
      .child(label);
    // Swatches (a ring on the chosen one) and a hex box for any other color.
    const colors = (key, choices) => h_flex().flex_none().gap(6).items_center()
      .children(Object.entries(choices).map(([value, name]) => div().id(`look-${key}-${value}`).size(18).rounded(9).cursor_pointer()
        .bg(value === "theme" ? theme().foreground : value)
        .border(2).border_color(String(look[key]).toLowerCase() === value ? t.accent : t.border)
        .tooltip(name)
        .on_click(() => { setLook({ [key]: value }); this.hex[key].set_value(HEX.test(value) ? value : ""); })))
      .child(div().w(76).h(24).px(6).flex().items_center().rounded(5).border(1).border_color(t.border).bg(t.surface)
        .text_size(12).text_color(t.foreground).child(Input.new(this.hex[key])));
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .when(Boolean(agent.address), el => el
        .child(div().px(8).py(6).text_color(t.dim).child(`${agent.label} · ${agent.address}`))
        .child(row("Commands", this.button(t, "agent-commands", "All / commands", () => {
          if (kind !== "pi") return openAgentControls(agent);
          const key = props()?.piCommandRoute;
          if (typeof key !== "string" || !/^pi-command-palette-[a-z0-9]+-[a-z0-9]+$/.test(key)) return;
          run(`any-chat.${key}`);
          closeOverlay();
        })))
        .when(kind === "pi" || kind === "opencode", el => el.child(row("Models", this.button(t, "agent-models", "Available models", () =>
          kind === "pi" ? openPiPicker(agent)
            : openAgentControls(agent, "/models")))))
        .child(div().px(8).pt(8).text_size(11).text_color(t.dim).child("Appearance · shared by all chats")))
      .child(h_flex().px(8).pt(4).pb(4).items_center().justify_between()
        .child(div().text_size(11).text_color(t.dim).child("Chat"))
        .child(div().id("look-reset").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click(() => { setShared(LOOK, null); for (const s of Object.values(this.hex)) s.set_value(""); }).child("Reset")))
      .child(row("Text size", pills(step("look-smaller", "A−", -1), div().w(28).text_center().text_color(t.foreground).child(String(look.size)), step("look-bigger", "A+", 1))))
      .child(row("Font", pills(seg("font", "ui", "Sans"), seg("font", "mono", "Mono"))))
      .child(row("Width", pills(seg("width", "full", "Full"), seg("width", "narrow", "Narrow"))))
      .child(row("Tool calls", pills(seg("tools", "show", "Show"), seg("tools", "hide", "Hide"))))
      .child(row("Earlier turns", pills(seg("history", "fold", "Fold"), seg("history", "show", "Show"))))
      .child(row("Accent", h_flex().flex_none().gap(6).children(Object.entries(ACCENTS).map(([key, color]) =>
        div().id(`look-accent-${key}`).size(18).rounded(9).cursor_pointer().bg(color ?? t.accent)
          .border(2).border_color(look.accent === key ? t.foreground : "#00000000")
          .tooltip(key === "theme" ? "Theme's accent" : key[0].toUpperCase() + key.slice(1))
          .on_click(() => setLook({ accent: key }))))))
      .child(row("Your messages", pills(seg("mine", "box", "Box"), seg("mine", "tint", "Tint"), seg("mine", "bar", "Bar"))))
      .child(row("Background", pills(seg("bg", "background", "Terminal"), seg("bg", "chrome", "Panel"), seg("bg", "canvas", "Canvas"))))
      .child(row("", colors("bg", BGS)))
      .child(row("Text (all of Herdr)", colors("fg", { theme: "Theme's", ...FGS })))
      .child(row("Spacing", pills(seg("space", "tight", "Tight"), seg("space", "normal", "Normal"), seg("space", "roomy", "Roomy"))))
      .child(div().px(8).pt(10).pb(4).text_size(11).text_color(t.dim).child("+ menu"))
      .child(row("Claude (dev container)", this.dev === "error"
        ? div().text_size(11).text_color(t.dim).child("programs.json isn't valid JSON")
        : pills(...[[false, "Off"], [true, "On"]].map(([on, label]) => div().id(`dev-${label}`).px(8).h(22).flex().items_center().rounded(5)
          .text_size(12).cursor_pointer()
          .when(this.dev === on, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(this.dev !== on, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
          .on_click((_e, cx) => {
            if (this.dev === on || this.dev === null) return;
            this.dev = on;
            setShared(DEV_CHOICE, on);
            cx.spawn(async (cx) => {
              try { await setDevContainer(on); } catch { this.dev = "error"; }
              cx.notify();
            });
          })
          .child(label)))));
  }

  // props.block (navidalex): keep this chat's own block sized for the look's width (blockSize),
  // so a full-width look gets the whole row and a narrow one the centered column.
  syncBlock(look, cx) {
    const id = props()?.block;
    if (!id || checking()) return;
    const want = blockSize(look.width === "narrow");
    const key = JSON.stringify(want);
    if (this.blockSized === key) return;
    const find = (node) => (node?.id === id ? node : (node?.children ?? []).map(find).find(Boolean));
    const size = find(layout())?.size ?? {};
    this.blockSized = key;
    if (size.px === want.px && size.weight === want.weight) return;
    cx.timer.after(0, () => run("layout.resize", { id, ...want }));
  }

  // A scroller held at the bottom (GPUI's start at the top and can't be moved from here): the
  // messages hang from the bottom edge, `this.up` px lowered to show older ones. While scrolled
  // up, new messages grow `up` too, so what you're reading stays put.
  log(t, agent, rows, sub) {
    const clamp = (up) => Math.max(0, Math.min(up, (this.contentH ?? 0) - (this.viewH ?? 0)));
    const key = sub ? `${agent.address}-${sub.name}` : agent.address;
    const pad = chatPad(this.viewW ?? 0, chatLook().width === "narrow");
    return div().id(`log-${key}`).relative().flex_1().min_h(0).overflow_hidden()
      .on_size_change((s, cx) => { this.viewH = s.height; this.viewW = s.width; this.up = clamp(this.up ?? 0); cx.notify(); })
      .on_scroll_wheel((e, cx) => { this.up = clamp((this.up ?? 0) + e.delta.y); this.ctx = null; cx.notify(); })
      .on_mouse_down("right", (e, cx) => this.openCtx(e, cx))
      // The transcript is its own cached island: keystrokes reuse it.
      .child(island(div().id(`log-island-${key}`).absolute().inset_0()).child(v_flex().id(`log-body-${key}`).absolute().left(0).right(0).bottom(-(this.up ?? 0))
        .pl(pad).pr(pad).py(12).gap(GAPS[chatLook().space] ?? 10)
        .on_size_change((s, cx) => {
          const before = this.up ?? 0;
          if ((this.up > 0 || this.holdTop) && this.contentH) this.up += s.height - this.contentH;
          this.holdTop = false;
          this.contentH = s.height;
          this.up = clamp(this.up ?? 0);
          // Only a scroll offset change needs a redraw; the new content is already drawn.
          if (this.up !== before) cx.notify();
        })
        .when(Boolean(this.problem) && !this.items.length && !sub, (el) => el.child(div().text_color(t.dim).child(this.problem)))
        .children(rows)))
      .when(Boolean(this.ctx), (el) => el.child(this.ctxMenu(t)))
      .when(this.up > 40, (el) => {
        const prev = this.prevMine();
        const next = this.nextMine();
        const toPrev = prev === null ? null : clamp(prev);
        const toNext = next === null ? null : clamp(next);
        return el
          .when(toPrev !== null && toPrev > this.up + 1, (el) => el.child(h_flex().absolute().top(10).left(0).right(0).justify_center()
            .child(this.button(t, "prev-mine", "↑ Previous message", (_e, cx) => { this.up = toPrev; cx.notify(); }))))
          .child(h_flex().absolute().bottom(10).left(0).right(0).gap(6).justify_center()
            .when(toNext !== null && toNext < this.up - 1, (el) => el.child(this.button(t, "next-mine", "↓ Next message", (_e, cx) => { this.up = toNext; cx.notify(); })))
            .child(this.button(t, "newest", "↓ Newest", (_e, cx) => { this.up = 0; cx.notify(); }, true)));
      });
  }

  // ---- the right-click menu

  // A right-click on a message: the menu is about this message. The log's handler (openCtx) runs
  // too, in either order: whichever comes second completes the other's half.
  ctxHit(e, item) {
    if (this.ctx && this.ctx.at.x === e.position.x && this.ctx.at.y === e.position.y) this.ctx.text = item.text;
    else this.ctxItem = { at: e.position, text: item.text };
  }

  // A right-click anywhere in the log opens the menu there. The selected text can't be had: a
  // TextView has no selection API, and running Herdr's copy from here (terminal.copy, the
  // shell_root::Copy and input::Copy actions Ctrl+C goes through) left the clipboard untouched
  // (tried 2026-11-06), so the menu works on whole messages.
  openCtx(e, cx) {
    const hit = this.ctxItem;
    // The position comes in window pixels; lengths are laid out at the zoom (as my-tabs does).
    const z = settings().zoom || 1;
    const local = e.local_position ?? { x: 0, y: 0 };
    const text = hit && hit.at.x === e.position.x && hit.at.y === e.position.y ? hit.text : null;
    this.ctxItem = null;
    this.ctx = { at: e.position, x: local.x / z, y: local.y / z, text };
    cx.notify();
  }

  // Copy message = the whole message as written (markdown); Quote in chat = it goes into the box
  // as a "> " quote. A press anywhere else closes the menu.
  ctxMenu(t) {
    const W = 200, H = 2 * 27 + 8;
    const x = Math.max(0, Math.min(this.ctx.x, (this.viewW ?? W) - W));
    const y = this.ctx.y + H > (this.viewH ?? 0) ? Math.max(0, this.ctx.y - H) : this.ctx.y;
    const close = (cx) => { this.ctx = null; cx.notify(); };
    const text = this.ctx.text;
    const row = (id, label, onClick) => h_flex().id(`ctx-${id}`).h(26).px(8).gap(8).items_center().rounded(5)
      .text_size(px(12.5)).text_color(text ? t.foreground : t.dim)
      .when(Boolean(text), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { onClick(cx); close(cx); }))
      .child(label);
    return v_flex().id("ctx-menu").absolute().left(x).top(y).w(W).p(4).gap(1).rounded(8)
      .bg(t.popover).border(1).border_color(t.border).shadow_md()
      .on_mouse_down_out((_e, cx) => close(cx))
      .child(row("copy-msg", "Copy message", (cx) => cx.write_to_clipboard(text)))
      .child(row("quote", "Quote message in chat", () => this.quote(text)));
  }

  // Puts text into the box as a markdown quote, after what's there, and gives the box the keyboard.
  quote(text) {
    const quoted = text.trim().split(/\r?\n/).map((l) => `> ${l}`).join("\n");
    const had = this.box.value();
    this.box.set_value(had.trim() ? `${had.replace(/\s+$/, "")}\n\n${quoted}\n\n` : `${quoted}\n\n`);
    this.box.focus();
  }

  // The `up` that puts the nearest of your messages starting above the view at its top, or null
  // if none is loaded. Rows hang from the bottom, so a row's top is the heights below it summed.
  prevMine() {
    const room = 44; // below the button, which floats at the top

    const gap = GAPS[chatLook().space] ?? 10;
    const viewTop = (this.up ?? 0) + (this.viewH ?? 0) - room;
    let below = 12; // the body's bottom padding
    for (let k = (this.rowList ?? []).length - 1; k >= 0; k--) {
      const h = this.rowH.get(this.rowList[k].id);
      if (h === undefined) return null;
      const top = below + h;
      if (this.rowList[k].mine && top > viewTop + 4) return top - (this.viewH ?? 0) + room;
      below = top + gap;
    }
    return null;
  }

  // The `up` that puts the nearest of your messages below the current top at the top of the view.
  nextMine() {
    const room = 44;
    const gap = GAPS[chatLook().space] ?? 10;
    const viewTop = (this.up ?? 0) + (this.viewH ?? 0) - room;
    let below = 12;
    let candidate = null;
    for (let k = (this.rowList ?? []).length - 1; k >= 0; k--) {
      const h = this.rowH.get(this.rowList[k].id);
      if (h === undefined) return null;
      const top = below + h;
      if (this.rowList[k].mine && top < viewTop - 4) candidate = Math.max(0, top - (this.viewH ?? 0) + room);
      below = top + gap;
    }
    return candidate;
  }

  // ---- search

  openFind(cx) {
    this.findOpen = true;
    // What was searched last is kept, selected, so typing replaces it.
    this.findQ = this.findBox.value().trim();
    this.findBox.set_selected_range({ start: 0, end: this.findBox.value().length });
    cx.timer.after(30, () => this.findBox.focus());
    cx.notify();
  }

  closeFind(cx) {
    this.findOpen = false; this.findQ = ""; this.findList = []; this.findAt = null; this.findKey = null; this.findWhat = null; this.seek = null;
    this.box.focus();
    cx.notify();
  }

  // -1: the older hit, 1: the newer (both wrap round). A query still settling is taken first.
  findStep(dir, cx) {
    const q = this.findBox.value().trim();
    if (q !== this.findQ) { this.findQ = q; return cx.notify(); }
    const n = this.findList.length;
    if (!n) return;
    this.findAt = ((this.findAt ?? n - 1) + dir + n) % n;
    this.seekTo(this.findList[this.findAt]);
    cx.notify();
  }

  // Scrolls to a hit (see resolveSeek). A hit in a tool's input or output, not its one-line
  // summary, opens the row.
  seekTo({ item, id }) {
    this.seek = id; this.seekTries = 0; this.seekShown = false;
    if (item.kind === "tool" && !AGENT_TOOLS.has(item.name) && item.name !== "AskUserQuestion"
      && !findRe(this.findQ).test(`${item.name} ${toolLine(item.name, item.input)}`)) this.open.add(item.id);
  }

  // The hits among what can be shown ([item, row id] pairs), as a set of row ids. Searched again
  // only when the query or the conversation changed; a new query (or agent) goes to the newest
  // hit, new lines keep the current one.
  findings(entries, sub) {
    if (!this.findOpen || !this.findQ) { this.findList = []; this.findAt = null; this.findKey = null; this.findWhat = null; return new Set(); }
    const what = JSON.stringify([this.findQ, this.address, sub?.name ?? null]);
    const key = `${what}|${entries.length}|${this.version}`;
    if (key !== this.findKey) {
      const re = findRe(this.findQ);
      const was = this.findList[this.findAt]?.id;
      this.findList = entries.filter(([item]) => re.test(searchText(item))).map(([item, id]) => ({ item, id }));
      const k = what === this.findWhat ? this.findList.findIndex((m) => m.id === was) : -1;
      this.findAt = k >= 0 ? k : this.findList.length ? this.findList.length - 1 : null;
      if (what !== this.findWhat && this.findAt !== null) this.seekTo(this.findList[this.findAt]);
      this.findWhat = what; this.findKey = key;
    }
    return new Set(this.findList.map((m) => m.id));
  }

  // The mark color for the hits in row `id`'s text (brighter in the current one), or null.
  markIn(id) {
    const m = this.marks;
    return m?.found.has(id) ? (id === m.current ? MARK.current : MARK.hit) : null;
  }

  // Puts the row being sought in the middle of the view (its top, if it's taller), once the rows
  // are measured: a frame or more after the jump, so a turn or tool row it opened has its height.
  resolveSeek(cx) {
    const list = this.rowList ?? [];
    const k = list.findIndex((r) => r.id === this.seek);
    const tries = this.seekTries++;
    const ready = k >= 0 && tries > 0 && list.slice(k).every((r) => this.rowH.has(r.id));
    if (!ready && tries < 6) { cx.timer.after(80, (cx) => cx.notify()); return; }
    this.seek = null;
    if (k < 0) return;
    const gap = GAPS[chatLook().space] ?? 10;
    let below = 12; // the body's bottom padding
    for (let j = list.length - 1; j > k; j--) below += (this.rowH.get(list[j].id) ?? 0) + gap;
    const h = this.rowH.get(list[k].id) ?? 0;
    const view = this.viewH ?? 0;
    const up = h > view - 60 ? below + h - view + 30 : below + h / 2 - view / 2;
    this.up = Math.max(0, Math.min(up, (this.contentH ?? 0) - view));
  }

  findBar(t) {
    const n = this.findList.length;
    const count = !this.findQ ? "" : n ? `${this.findAt + 1} of ${n}` : "No matches";
    const icon = (id, label, tip, onClick) => div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(5)
      .cursor_pointer().text_color(n ? t.foreground : t.dim).hover((s) => s.bg(t.hover)).tooltip(tip).on_click(onClick).child(label);
    return h_flex().id("find-bar").track_focus(this.findKeys).h(38).flex_none().px(12).gap(8).items_center()
      .border_b(1).border_color(t.border).bg(t.chrome).text_size(12)
      // Keys pass through here on their way up from the search box.
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.closeFind(cx);
        else if (e.key === "up") this.findStep(-1, cx);
        else if (e.key === "down") this.findStep(1, cx);
        else return;
        cx.stop_propagation();
      })
      .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).h(26).px(6).flex().items_center().rounded(6).bg(t.background).border(1).border_color(t.input)
        .text_color(t.foreground).child(Input.new(this.findBox)))
      .child(div().flex_none().text_color(n || !this.findQ ? t.dim : t.blocked).child(count))
      .child(icon("find-prev", "↑", "Older match (Enter, ↑)", (_e, cx) => this.findStep(-1, cx)))
      .child(icon("find-next", "↓", "Newer match (Shift+Enter, ↓)", (_e, cx) => this.findStep(1, cx)))
      .child(div().id("find-close").flex_none().size(24).flex().items_center().justify_center().rounded(5).cursor_pointer()
        .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
        .on_click((_e, cx) => this.closeFind(cx)).child("×"));
  }

  // Footer strip: context used, output tokens, cost, and the plan's limits (Claude's from its
  // status line file, Codex's from its rollout). The Claude plan file is re-read every 20 s.
  usageBar(t, cx) {
    const u = this.usage;
    if (!u || !this.kind || this.kind === "opencode") return null;
    const model = u.model ?? this.model;
    const claudePlan = usesClaudePlan(this.kind, model);
    if (claudePlan && Date.now() - (this.planRead ?? 0) > 20000) {
      this.planRead = Date.now();
      cx.spawn(async (cx) => {
        const plan = await readPlan();
        const sig = JSON.stringify(plan?.rate_limits ?? null);
        if (sig !== this.planSig) { this.planSig = sig; this.plan = plan; cx.notify(); }
      });
    }
    const limits = claudePlan ? planWindows(this.plan) : this.kind === "codex" ? (u.limits ?? []) : [];
    if (!u.ctx && !limits.length) return null;
    const liveModels = this.piMeta?.models ?? this.piMeta?.control?.models ?? null;
    const max = u.ctxMax || contextOf(model, liveModels);
    const pct = max ? Math.min(100, Math.round((u.ctx / max) * 100)) : null;
    const level = (p) => (p >= 90 ? t.blocked : p >= 70 ? t.ansi3 : t.accent);
    const bar = (p, w) => div().w(w).h(4).flex_none().rounded(2).bg(t.raised)
      .child(div().h_full().rounded(2).w(Math.max(1, Math.round((w * Math.min(100, p)) / 100))).bg(level(p)));
    const sep = () => div().text_color(t.dim).child("·");
    return h_flex().id("chat-usage").flex_none().px(4).gap(8).items_center().text_size(px(11)).text_color(t.muted)
      .when(u.ctx > 0, (el) => el.child(h_flex().id("usage-ctx").gap(6).items_center()
        .tooltip(model ? `Context of the last reply · ${model}` : "Context of the last reply")
        .child(div().text_color(t.dim).child("ctx"))
        .when(pct !== null, (el) => el.child(bar(pct, 56)))
        .child(div().text_color(t.foreground).child(max ? `${tokens(u.ctx)} / ${tokens(max)}` : tokens(u.ctx)))
        .when(pct !== null, (el) => el.child(div().text_color(level(pct)).child(`${pct}%`)))))
      .when(u.out > 0, (el) => el.child(sep()).child(div().id("usage-out").tooltip("Output tokens this session").child(`↑ ${tokens(u.out)} out`)))
      .when(u.cost > 0, (el) => el.child(sep()).child(div().id("usage-cost").tooltip("Cost this session").child(`$${u.cost.toFixed(2)}`)))
      .children(limits.map((w) => {
        const left = until(w.resets);
        const used = Math.max(0, Math.min(100, Math.round(w.pct)));
        return h_flex().id(`usage-${w.short}`).gap(5).items_center()
          .tooltip(`${claudePlan ? "Claude plan" : "Codex plan"} · ${w.short}: ${used}% used, ${100 - used}% left${left ? ` · resets in ${left}` : ""}`)
          .child(sep()).child(div().text_color(t.dim).child(w.short)).child(bar(used, 36))
          .child(div().text_color(level(used)).child(`${100 - used}% left`))
          .when(Boolean(left), (el) => el.child(div().text_color(t.dim).child(`↻ ${left}`)));
      }))
      .when(claudePlan && !limits.length, (el) => el.child(sep()).child(div().text_color(t.dim).child("plan: waiting for Claude's status line")));
  }

  render(cx) {
    if (props()?.settings) return this.settingsMenu(theme());
    chatTheme.kind = this.kind;
    const t = chatTheme();
    const agent = this.target();
    // Another agent: show what's kept of it now and catch up at once, not on the next 2 s tick.
    if ((agent?.address ?? null) !== this.address) {
      this.reset(agent?.address ?? null);
      cx.timer.after(0, (cx) => this.tick(cx));
    }
    // Clicking a character or a tab gives the keyboard to that (hidden) terminal: take it back
    // whenever the chat comes on screen or changes agent, so typing lands in the box.
    const seen = this.showing() ? agent?.address ?? "" : null;
    if (seen && seen !== this.seen) cx.timer.after(50, () => this.box.focus());
    this.seen = seen;
    const look = chatLook();
    this.syncBlock(look, cx);
    const root = v_flex().size_full().min_h(0).bg(t.background).text_size(px(13));
    // The chosen font goes to the messages and the box, not the header.
    const font = (el) => el.when(look.font === "mono", (el) => el.font_family(this.mono()));
    if (!agent) {
      // A tab with no Claude goes to the Terminal now rather than on the next 2 s tick.
      if (props()?.stack) cx.timer.after(0, () => this.autoView(null));
      const text = starting(focused()?.tab) ? "Starting the agent…" : "No Claude, Pi, Codex or OpenCode agent in this tab.";
      return root.items_center().justify_center().gap(10).text_color(t.dim).child(text)
        .when(Boolean(props()?.stack), (el) => el.child(this.button(t, "show-terminal", "Show terminal", () => this.toTerminal())));
    }
    // An opened sub-agent shows its conversation instead (gone after /clear: back to the chat).
    const sub = this.subs.get(this.trail[this.trail.length - 1]) ?? null;
    if (!sub) this.trail = [];
    this.agentNow = sub ? null : agent;
    // Each item with its index, which its row ids use; tool calls left out if hidden (not sub-agents or questions).
    const visible = ([item]) => look.tools === "show" || ["user", "claude", "note", "thinking"].includes(item.kind) || AGENT_TOOLS.has(item.name) || ask.isQuestionTool(item.name);
    // Questions a hook sent back are left out: Claude asks again at once.
    const all = (sub ? sub.items : this.items).map((item, i) => [item, sub ? `${sub.name}-${i}` : i])
      .filter(([item]) => !ask.rejected(item));
    const found = this.findings(all.filter(visible), sub);
    const current = this.findList[this.findAt]?.id;
    this.marks = found.size ? { re: findRe(this.findQ, "gi"), found, current } : null;
    let listed = sub || look.history === "show" ? all.filter(visible) : this.turns(all, visible);
    // The hit being sought: inside a folded turn, the turn opens; above the loaded rows, more load.
    if (this.seek !== null && !this.seekShown) {
      this.seekShown = true;
      const fold = listed.find((x) => x.work && !x.open && x.work.some(([, id]) => id === this.seek));
      if (fold) { this.unfolded.add(fold.key); listed = this.turns(all, visible); }
      const at = listed.findIndex((x) => !x.work && x[1] === this.seek);
      if (at >= 0 && listed.length - at > this.limit) this.limit = listed.length - at + 10;
    }
    const shown = listed.slice(-this.limit);
    const hidden = listed.length - shown.length;
    this.agentWorking = agent.status === "working";
    this.lastThinking = this.items.findLastIndex((x) => x.kind === "thinking");
    // Each row measured, so ↑ Previous message knows where your messages are (see prevMine).
    this.rowList = shown.map((x) => ({ id: x.work ? x.key : x[1], mine: !x.work && x[0].kind === "user" }));
    const rows = shown.map((x, k) => {
      const id = this.rowList[k].id;
      const hit = !x.work && found.has(id);
      return div().id(`row-${id}`).w_full()
        .on_size_change((s) => { this.rowH.set(id, s.height); })
        // Search hits tinted, the current one outlined (the same padding on all, so moving between
        // them doesn't shift the rows).
        .when(hit, (el) => el.p(3).rounded(8).border(1).bg(fade(t.accent, id === current ? "1f" : "0d"))
          .border_color(id === current ? t.accent : fade(t.accent, "33")))
        .child(x.work ? this.turnRow(t, x, found) : this.bubble(t, x[0], x[1]));
    });
    if (this.seek !== null) this.resolveSeek(cx);
    // Messages sent while Claude works, waiting in its prompt (not in a sub-agent's view).
    if (!sub && this.live && agent.status === "working") {
      rows.push(h_flex().w_full().pl(16).gap(8).items_center().py(2).px(6)
        .child(h_flex().w(12).flex_none().justify_center().child(div().text_size(px(12)).text_color(t.ansi5).when(shared("p5.motion") !== false, (el) => el.frames(THINK_SPIN, 90)).child(THINK_SPIN[0])))
        .child(div().flex_1().min_w(0).truncate().text_size(px(12)).text_color(t.muted).child(this.live)));
    }
    if (!sub) {
      const queued = this.queuedNow(agent);
      rows.push(...queued.map((q, k) => this.queuedRow(t, q, k, agent)));
    }
    // Built once each: they're shown only when there is one.
    const chips = this.subChips(t);
    const status = this.status(t, agent);
    const usage = sub ? null : this.usageBar(t, cx);
    const tray = this.imageTray(t, agent);
    const menu = this.menu(t);
    const historyActive = !menu && (!this.typed.includes("\n") || this.historyFor(agent.address).browsing);
    const piBtnLabel = this.kind === "pi" ? piModelButtonLabel(this.piMeta, this.model) : "Model";
    this.settlePick();
    if (hidden > 0) rows.unshift(h_flex().w_full().justify_center().child(
      this.button(t, "earlier", `Show earlier (${hidden})`, (_e, cx) => { this.limit += PAGE; cx.notify(); })));

    // Ctrl+F from anywhere in the chat (the box, the search box) opens the search, or goes back to it.
    return root.id("chat-root").track_focus(this.rootKeys)
      .on_drop((e, cx) => this.handleDrop(e.paths, cx))
      .on_key_down((e, cx) => {
        if (this.subKey(e, agent.status, menu, cx)) return;
        if (e.keystroke === "escape" && agent.status === "working" && !this.stuck && !menu) { cx.stop_propagation(); this.stop(cx); return; }
        if (!["ctrl-f", "cmd-f"].includes(e.keystroke)) return;
        cx.stop_propagation();
        this.openFind(cx);
      })
      .child(h_flex().h(32).flex_none().text_size(12).px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.background)
        .child(div().size(8).flex_none().rounded(4).bg(t[agent.status] ?? t.dim))
        // Context and quota, top left.
        .when(Boolean(usage), (el) => el.child(usage))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(agent.title || NAMES[kindOf(agent)] || "Agent"))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${NAMES[kindOf(agent)] ?? ""}${this.model && kindOf(agent) !== "claude" ? " · " + this.model : ""} · ${agent.space_name} · ${agent.address}`))
        .when(Boolean(this.forkNote), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(this.forkNote)))
        .child(div().id("chat-sessions").flex_none().px(6).py(3).rounded(6).cursor_pointer()
          .text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Session history (Ctrl+Shift+Y)")
          .on_click(() => openOverlay({ mod: "session-history", kind: "dialog", width: 0.72, height: 0.76 }))
          .child("History"))
        .child(div().id("chat-find").flex_none().p(4).rounded(6).cursor_pointer()
          .text_color(this.findOpen ? t.foreground : t.dim).when(this.findOpen, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Search this chat (Ctrl+F)")
          .on_click((_e, cx) => (this.findOpen ? this.closeFind(cx) : this.openFind(cx)))
          .child(svg("mods/workspace-chrome/search.svg").size(14)))
        .when(this.kind === "claude" && Boolean(this.session?.sessionId) && !sub, (el) => el.child(div().id("chat-fork").flex_none().p(4).rounded(6)
          .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Fork: a copy of this conversation in a new tab")
          .on_click((_e, cx) => cx.spawn(async (cx) => { await this.fork(agent, undefined, cx); }))
          .child(svg("mods/workspace-chrome/git-branch.svg").size(14))))
        .child(div().id("chat-settings").flex_none().p(4).rounded(6).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Chat settings")
          .on_click(() => openOverlay({ mod: "any-chat", kind: "popup", width: 380, height: 640,
            props: { settings: true, terminal: agent.address, agentName: NAMES[this.kind], agentKind: this.kind,
              piCommandRoute: this.kind === "pi" ? this.piCommandsRoute(agent.address) : undefined } }))
          .child(svg("mods/workspace-chrome/settings.svg").size(14)))
        .child(props()?.stack ? slideSwitch(t, "view-switch", true, () => this.toTerminal(agent.address))
          : this.button(t, "terminal", "Terminal", () => this.toTerminal(agent.address))))
      .when(Boolean(sub), (el) => el.child(this.subBar(t, sub)))
      .when(this.findOpen, (el) => el.child(this.findBar(t)))
      .child(font(this.log(t, agent, rows, sub)))
      .child(font(v_flex()).flex_none().p(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome)
        .when(Boolean(chips), (el) => el.child(chips))
        .when(Boolean(status), (el) => el.child(status))
        .when(Boolean(this.pasteNote), (el) => el.child(div().px(4).text_size(px(12)).text_color(t.muted).child(this.pasteNote)))
        .when(Boolean(this.pickNote), (el) => el.child(div().px(4).text_size(px(12)).text_color(t.accent).child(this.pickNote)))
        .when(Boolean(tray), (el) => el.child(tray))
        .when(this.currentPiCommandRoute(this.piCommandOpen), (el) => el.child(this.piCommandsMenu(t)))
        .when(Boolean(menu), (el) => el.child(menu))
        .child(h_flex().id("composer").track_focus(this.keyboard)
          .when(Boolean(menu), (el) => el.key_context("ChatSlash"))
          .when(!menu && agent.status === "working" && !this.stuck, (el) => el.key_context("ChatStop"))
          .on_action("claude_chat_stop", (_e, cx) => this.stop(cx))
          .on_action("claude_chat_menu_down", (_e, cx) => this.menuKey("down", cx))
          .on_action("claude_chat_menu_up", (_e, cx) => this.menuKey("up", cx))
          .on_action("claude_chat_menu_fill", (_e, cx) => this.menuKey("fill", cx))
          .on_action("claude_chat_menu_close", (_e, cx) => this.menuKey("close", cx))
          .on_action("claude_chat_menu_leave", (_e, cx) => this.menuKey("leave", cx))
          .on_action("claude_chat_history_up", (_e, cx) => this.historyKey("up", cx))
          .on_action("claude_chat_history_down", (_e, cx) => this.historyKey("down", cx))
          .gap(6).items_end()
          .child(div().flex_1().min_w(0).p(6).rounded(8).bg(t.background).border(1).border_color(t.input)
            .when(historyActive, (el) => el.key_context("ChatHistory"))
            .child(Textarea.new(this.box)))
          .when(this.kind === "claude", (el) => el.child(h_flex().flex_none().gap(6).pb(4)
            .child(this.button(t, "claude-model", "Model", () => openAgentControls(agent, "/model")))
            .child(this.button(t, "claude-effort", "Effort", () => openAgentControls(agent, "/effort")))))
          .when(this.kind === "opencode", el => el.child(this.button(t, "opencode-models", "Models", () => openAgentControls(agent, "/models"))))
          .when(this.kind === "pi", (el) => el.child(h_flex().flex_none().gap(6).pb(4)
            .child(this.button(t, "pi-model", piBtnLabel, () => openPiPicker(agent)).tooltip("Model & Thinking (Ctrl+Shift+M)"))))));
  }
}
