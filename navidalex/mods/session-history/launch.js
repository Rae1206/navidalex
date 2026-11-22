// Resumes a session in a new tab, or focuses the terminal a live one runs in.
// Adapted from enchang1017/herdr-mod@d07a4d4 for Windows: the agent CLIs are resolved to full
// paths (the mod's PATH is minimal), npm `.cmd` shims run their node script directly, folders
// are checked with fs `exists` instead of `test -d`, and Pi sessions resume with `--session`.
import { hc, exec, run, spaces, focused, terminals, home } from "herdr";
import { exists, readFile } from "fs/promises";
import { shortTitle } from "./data.js";

const WAIT_MS = 250;
const WAIT_TRIES = 40;
const NAME_MAX = 32;
const PROGRAMS = { claude: "claude", codex: "codex", pi: "pi" };
const KNOWN = { claude: () => `${home()}\\.local\\bin\\claude.exe` };

const localId = (id) => String(id ?? "").split("/").pop();
const resolved = new Map();

function hcError(ran) {
  const text = (ran.stderr || ran.stdout || "").trim();
  try {
    const parsed = JSON.parse(text).error;
    return [parsed?.message, parsed?.hint].filter(Boolean).join(" ") || text;
  } catch {
    return text || `hc exited ${ran.code}`;
  }
}

async function present(path) {
  try {
    return await exists(path);
  } catch {
    return null; // outside what fs may read: unknown
  }
}

// Every application PowerShell (the shell agents start in) finds for `name`.
async function whereAll(name) {
  const script = `Get-Command ${name} -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }`;
  const ran = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000 }).catch(() => null);
  return (ran?.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// An npm shim (`codex.cmd`, `pi.cmd`) ends with `"%_prog%" "%dp0%\node_modules\...\cli.js" %*`:
// run that script with the shim's node.exe so arguments need no cmd.exe quoting.
async function fromShim(shim) {
  let text = "";
  try { text = await readFile(shim, "utf8"); } catch { return null; }
  const script = /"%dp0%\\([^"]+\.js)"/i.exec(text)?.[1];
  if (!script) return null;
  const dir = shim.replace(/[\\/][^\\/]+$/, "");
  const node = `${dir}\\node.exe`;
  const nodeBin = (await present(node)) ? node : (await whereAll("node")).find((p) => /\.exe$/i.test(p));
  return nodeBin ? [nodeBin, `${dir}\\${script}`] : null;
}

async function resolveProgram(kind) {
  const name = PROGRAMS[kind];
  const known = KNOWN[kind]?.();
  if (known && (await present(known))) return { argv: [known], direct: true };
  const found = await whereAll(name);
  const exe = found.find((p) => /\.exe$/i.test(p));
  if (exe) return { argv: [exe], direct: true };
  const shim = found.find((p) => /\.cmd$/i.test(p));
  if (shim) {
    const viaNode = await fromShim(shim);
    if (viaNode) return { argv: viaNode, direct: true };
    return { argv: ["cmd.exe", "/d", "/c", shim], direct: false };
  }
  throw new Error(`${name} not found on this computer`);
}

async function program(kind) {
  if (!resolved.has(kind)) resolved.set(kind, resolveProgram(kind).catch((e) => { resolved.delete(kind); throw e; }));
  return resolved.get(kind);
}

function targetSpace() {
  const f = focused();
  const current = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active) ?? null;
  if (current && !current.machine) return current;
  return spaces().find((s) => !s.machine) ?? null;
}

// The project folder the panel scopes to: the focused space's folder (empty means home).
export function projectFolder() {
  const space = targetSpace();
  return space ? (space.folder || home()) : null;
}

function newTabId() {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `tb${hex}`;
}

function terminalName(session) {
  const base = shortTitle(session, 20).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || session.kind;
  const taken = new Set(terminals().map((t) => t.name).filter(Boolean));
  const name = `${base}-${session.id.slice(0, 4)}`.slice(0, NAME_MAX);
  return taken.has(name) ? `${name.slice(0, NAME_MAX - 6)}-${String(Date.now()).slice(-5)}` : name;
}

function fallbackFolder() {
  return focused()?.cwd || home();
}

// Never adds permission-skipping flags: the session resumes with the person's own settings.
async function resumeArgv(session, fork) {
  const { argv, direct } = await program(session.kind);
  if (session.kind === "codex") return [...argv, "resume", session.id];
  // A path through cmd.exe would need its quoting; the id is enough there.
  if (session.kind === "pi") return [...argv, "--session", direct && session.path ? session.path : session.id];
  return [...argv, "--resume", session.id, ...(fork ? ["--fork-session"] : [])];
}

async function nameAndFocus(spaceId, tabId, address, title, cx) {
  for (let attempt = 0; attempt < WAIT_TRIES; attempt += 1) {
    const tab = spaces().find((s) => localId(s.id) === localId(spaceId))?.tabs.find((t) => localId(t.id) === tabId);
    if (tab) {
      run("tab.rename", { id: tab.id, name: title });
      run("tab.select", { id: tab.id });
      run("pane.focus", { terminal: address });
      return true;
    }
    await cx.sleep(WAIT_MS);
  }
  return false;
}

async function start(session, space, tabId, cwd, argv) {
  const args = ["run", "--bg", "--json", "--no-parent", "--name", terminalName(session), "--cwd", cwd,
    "--label", `herdr.space=${localId(space.id)}`, "--label", `herdr.tab=${tabId}`, "--", ...argv];
  return hc(args);
}

export async function resumeSession(session, fork, cx) {
  const space = targetSpace();
  if (!space) throw new Error("No space on this computer to open the session in.");
  const tabId = newTabId();
  const argv = await resumeArgv(session, fork);
  const there = session.cwd ? await present(session.cwd) : false;
  let cwd = there === false ? fallbackFolder() : session.cwd;
  let ran = await start(session, space, tabId, cwd, argv);
  if (ran.code !== 0 && there === null && cwd !== fallbackFolder()) {
    cwd = fallbackFolder(); // the folder could not be checked and hc refused it
    ran = await start(session, space, tabId, cwd, argv);
  }
  if (ran.code !== 0) throw new Error(hcError(ran));
  const address = JSON.parse(ran.stdout)?.address;
  if (!address) throw new Error("hc run did not return an address");
  const shown = await nameAndFocus(space.id, tabId, address, shortTitle(session), cx);
  return { address, shown, cwd };
}

async function foregroundPid(address) {
  const ran = await hc(["get", address, "--json"]);
  if (ran.code !== 0) return null;
  try {
    return JSON.parse(ran.stdout)?.foreground?.pid ?? null;
  } catch {
    return null;
  }
}

export async function terminalForPid(pid) {
  const local = terminals().filter((t) => t.state === "live" && t.address && !t.address.includes("/"));
  const pids = await Promise.all(local.map(async (t) => [t.address, await foregroundPid(t.address)]));
  return pids.find(([, found]) => found === pid)?.[0] ?? null;
}

export async function focusLive(session) {
  const address = await terminalForPid(session.pid);
  if (!address) return null;
  run("agent.focus", { terminal: address });
  return address;
}
