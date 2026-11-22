// Parses an ODD feature document (odd/tasks/<feature>.md) into specs and tasks.
// Pure: no herdr imports, so it can be checked with node.
//
// Shape: "# name", a short header, "## Specs" with "- S1 text", "## Tasks" with
// "- T1 S1 text — status" (the status is the text after the last em dash) or
// "- [x] T1 ..." checkboxes, then "## Log" (ignored). Older documents use task
// headings ("### T1 — title"); those count too.

export const STATUSES = ["done", "running", "pending", "blocked", "other"];

const WORDS = [
  ["done", /^(done|complete|completed|finished|passed|ok|verified|closed|merged|shipped|✓|✔)\b/],
  ["running", /^(running|in[ -]?progress|active|wip|working|ongoing|started|doing|partial)\b/],
  ["blocked", /^(blocked|failed|failing|fail|error|cancelled|canceled|stuck|rejected|needs[ -]decision)\b/],
  ["pending", /^(pending|todo|to do|open|not started|queued|planned|next|waiting|reopened)\b/],
];

// "done, check passed" -> "done"; unknown words -> null.
export function statusOf(text) {
  const s = String(text ?? "").trim().toLowerCase().replace(/^[*_`]+/, "");
  for (const [status, re] of WORDS) if (re.test(s)) return status;
  return null;
}

// "S1-S16", "S1+S2", "S3, S4", "S9" -> ["S1", ...]. Ranges are capped at 100 entries.
export function specRefs(text) {
  const out = [];
  const re = /\bS(\d+)(?:\s*[-–]\s*S?(\d+))?\b/g;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= Math.min(b, a + 100); n++) if (!out.includes(`S${n}`)) out.push(`S${n}`);
  }
  return out;
}

const strip = (s) => s.replace(/\*\*|__|`/g, "").trim();
const SPEC = /^\s*[-*+]\s+(?:\*\*)?(S\d+)(?:\*\*)?\b[:.)]?\s*(.*)$/;
const TASK = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(?:\*\*)?(T\d+)(?:\*\*)?\b[:.)]?\s*(.*)$/;
const TASK_HEADING = /^#{2,4}\s+(?:\[([ xX])\]\s+)?(T\d+)\b\s*[—:.\-–]?\s*(.*)$/;

function splitStatus(rest, box) {
  if (box) return { text: rest.trim(), status: box.toLowerCase() === "x" ? "done" : "pending", label: box.toLowerCase() === "x" ? "done" : "pending" };
  const at = rest.lastIndexOf("—");
  if (at >= 0) {
    const label = rest.slice(at + 1).trim();
    const text = rest.slice(0, at).trim();
    const status = statusOf(label);
    if (status) return { text, status, label };
    if (text) return { text, status: "other", label };
  }
  return { text: rest.trim(), status: null, label: "" };
}

export function parseOdd(source, path = "") {
  const lines = String(source ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const file = String(path).split(/[\\/]/).pop() ?? "";
  const doc = { path, name: file.replace(/\.md$/i, ""), header: [], specs: [], tasks: [] };
  let section = "", seenTitle = false, inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const title = /^#\s+(.+)$/.exec(line);
    if (title && !seenTitle) { doc.name = strip(title[1]); seenTitle = true; continue; }
    const head = /^##\s+(.+)$/.exec(line);
    if (head && !TASK_HEADING.test(line)) {
      section = strip(head[1]).toLowerCase();
      if (section === "log" || section.startsWith("log ")) break;
      continue;
    }
    if (!section && seenTitle && line.trim() && doc.header.length < 3 && !/^#/.test(line)) { doc.header.push(strip(line)); continue; }

    const th = TASK_HEADING.exec(line);
    if (th) {
      const { text, status, label } = splitStatus(th[3], th[1]);
      doc.tasks.push({ id: th[2], text: strip(text), status: status ?? "pending", label: label || "pending", specs: specRefs(text) });
      continue;
    }
    const sp = SPEC.exec(line);
    if (sp && !/^tasks?\b|work units/.test(section)) {
      if (!doc.specs.some((s) => s.id === sp[1])) doc.specs.push({ id: sp[1], text: strip(sp[2]) });
      continue;
    }
    const tk = TASK.exec(line);
    if (tk) {
      const { text, status, label } = splitStatus(tk[3], tk[1]);
      const body = text.replace(/^(S\d+(?:\s*[-–+,&]\s*S?\d+)*)\s*/, "");
      doc.tasks.push({ id: tk[2], text: strip(text), title: strip(body) || strip(text), status: status ?? "pending", label: label || "pending", specs: specRefs(text) });
    }
  }
  for (const t of doc.tasks) t.title ??= t.text;
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const t of doc.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
  doc.counts = counts;
  doc.total = doc.tasks.length;
  doc.done = counts.done;
  doc.complete = doc.total > 0 && doc.done === doc.total;
  return doc;
}
