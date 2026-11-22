// Runs index.py and shapes its sessions for the panel.
// Adapted from enchang1017/herdr-mod@d07a4d4 for Windows: Python is resolved to a real
// interpreter (the mod's PATH is minimal and `python3` is the Microsoft Store stub), and
// sessions can be scoped to the active space's project folder.
import { exec, appHome, home } from "herdr";

export const SEARCH_LIMIT = 50;

const scriptPath = () => `${appHome()}/mods/session-history/index.py`;
const cachePath = () => `${appHome()}/data/session-history/index.json`;

// PowerShell (System32, found without PATH) is asked for a Python 3 that is not the Store stub.
const FIND_PYTHON = "Get-Command python,python3,py -CommandType Application -All -ErrorAction SilentlyContinue | "
  + "Where-Object { $_.Source -notlike '*WindowsApps*' } | ForEach-Object { $_.Source }";

let pythonPromise = null;

async function isPython3(bin) {
  try {
    const ran = await exec(bin, ["-I", "-c", "import sys; print(sys.version_info[0])"], { timeout: 10_000 });
    return ran.code === 0 && ran.stdout.trim() === "3";
  } catch {
    return false;
  }
}

async function findPython() {
  const found = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", FIND_PYTHON], { timeout: 15_000 }).catch(() => null);
  const candidates = (found?.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  candidates.push(`${home()}\\AppData\\Local\\Programs\\Python\\Python312\\python.exe`, "python");
  for (const bin of candidates) if (await isPython3(bin)) return bin;
  throw new Error("Python 3 not found (install it from python.org; the Microsoft Store stub does not work)");
}

function python() {
  if (!pythonPromise) pythonPromise = findPython().catch((error) => { pythonPromise = null; throw error; });
  return pythonPromise;
}

function parseOutput(ran, what) {
  if (ran.code !== 0) throw new Error(`${what} failed: ${(ran.stderr || ran.stdout).trim().slice(0, 300) || `exit ${ran.code}`}`);
  try {
    return JSON.parse(ran.stdout);
  } catch {
    throw new Error(`${what} gave no JSON: ${ran.stdout.trim().slice(0, 200)}`);
  }
}

export async function loadIndex() {
  const ran = await exec(await python(), ["-I", scriptPath(), "index", cachePath()], { timeout: 60_000 });
  const out = parseOutput(ran, "Indexing sessions");
  return { sessions: out.sessions ?? [], pending: out.pending === true, errors: out.errors ?? [] };
}

export async function searchText(query) {
  const ran = await exec(await python(), ["-I", scriptPath(), "search", query, String(SEARCH_LIMIT)], { timeout: 60_000 });
  const out = parseOutput(ran, "Searching transcripts");
  return { hits: out.hits ?? [], truncated: out.truncated === true };
}

// Comparable folder: forward slashes, no trailing slash, lower case (Windows paths ignore case).
export function normPath(path) {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// A session belongs to the project when it ran in its folder or below. At home only exact
// matches count, or every session under the home folder would belong to it.
export function inProject(session, folder) {
  if (!folder) return true;
  const root = normPath(folder);
  const cwd = normPath(session.cwd);
  if (!cwd) return false;
  if (root === normPath(home())) return cwd === root;
  return cwd === root || cwd.startsWith(`${root}/`);
}

function haystack(session) {
  return [session.title, session.name, session.cwd, session.repo, session.branch, session.id, session.kind].filter(Boolean).join(" ").toLowerCase();
}

export function filterSessions(sessions, query, hits, folder = null) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const snippets = new Map((hits ?? []).map((hit) => [hit.id, hit.snippet]));
  return sessions
    .filter((s) => inProject(s, folder))
    .filter((s) => words.every((w) => haystack(s).includes(w)) || snippets.has(s.id))
    .map((s) => (snippets.has(s.id) ? { ...s, snippet: snippets.get(s.id) } : s));
}

export function displayTitle(session) {
  return session.name || session.title || "(no prompt)";
}

export function shortTitle(session, max = 28) {
  const text = displayTitle(session).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function baseName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? String(path ?? "");
}

export function folderLabel(session) {
  if (!session.cwd) return session.repo ?? "unknown folder";
  const base = normPath(session.cwd) === normPath(home()) ? "~" : baseName(session.cwd);
  return session.repo && session.repo !== base ? `${base} · ${session.repo}` : base;
}

export function ageLabel(mtimeSeconds, now) {
  const minutes = Math.max(0, Math.floor((now - mtimeSeconds * 1000) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 30) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 43200)}mo`;
}

export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function branchLabel(session) {
  return session.branch && session.branch !== "HEAD" ? session.branch : null;
}
