import { readdir } from "fs/promises";
import { isImagePath, joinPath } from "./images.js";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
  "out",
  "coverage",
  ".venv",
  "__pycache__",
  ".pi",
]);

const baseName = (p) => String(p ?? "").replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";

export function mentionAt(text, caret) {
  const s = String(text ?? "");
  const end = Math.max(0, Math.min(s.length, Number.isFinite(caret) ? caret : s.length));
  const before = s.slice(0, end);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/[\s(\[]/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, end, query };
}

export function fuzzyScore(query, target) {
  const q = String(query ?? "").trim().toLowerCase();
  const t = String(target ?? "").toLowerCase();
  if (!q) return 1;
  if (!t) return 0;
  const name = baseName(t);
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - Math.min(200, name.length - q.length);
  const nameIdx = name.indexOf(q);
  if (nameIdx !== -1) return 600 - Math.min(200, nameIdx * 5 + (name.length - q.length));
  const fullIdx = t.indexOf(q);
  if (fullIdx !== -1) return 400 - Math.min(200, fullIdx * 2);
  let qi = 0;
  let gaps = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi += 1;
    else if (qi > 0) gaps += 1;
  }
  if (qi === q.length) return Math.max(10, 200 - gaps);
  return 0;
}

export function matchMentions(query, images = [], files = [], limit = 10) {
  const q = String(query ?? "").trim().toLowerCase();
  const imgKeyword = /^(img|imgs|image|images|imagen|imagenes|foto|shot|clip)(:|$)/.test(q);
  const effectiveQ = q.startsWith("img:") ? q.slice(4) : imgKeyword ? "" : q;

  const candidates = [];
  const seenAbs = new Set();

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.absPath) continue;
    const key = img.absPath.toLowerCase();
    if (seenAbs.has(key)) continue;
    seenAbs.add(key);
    const baseScore = effectiveQ ? fuzzyScore(effectiveQ, img.name ?? img.relPath) : 500 - i;
    if (baseScore <= 0) continue;
    const boost = imgKeyword ? 1500 : q ? 40 : 1000;
    candidates.push({
      kind: "image",
      label: img.name ?? baseName(img.absPath),
      detail: img.relPath ?? "image",
      relAsset: img.relPath ?? null,
      absPath: img.absPath,
      insertText: img.absPath,
      score: baseScore + boost,
    });
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f?.relPath || !f?.absPath) continue;
    const key = f.absPath.toLowerCase();
    if (seenAbs.has(key)) continue;
    seenAbs.add(key);
    const isImg = Boolean(f.isImage || isImagePath(f.relPath));
    const baseScore = effectiveQ ? fuzzyScore(effectiveQ, f.relPath) : isImg ? 400 - i : 200 - Math.min(180, i);
    if (baseScore <= 0) continue;
    if (imgKeyword && !isImg) continue;
    const boost = isImg ? (imgKeyword ? 1400 : 25) : 0;
    candidates.push({
      kind: isImg ? "image" : "file",
      label: baseName(f.relPath),
      detail: f.relPath,
      relAsset: null,
      absPath: f.absPath,
      insertText: f.relPath,
      score: baseScore + boost,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return candidates.slice(0, limit);
}

export function applyMention(text, span, replacement) {
  const s = String(text ?? "");
  const before = s.slice(0, span.start);
  const after = s.slice(span.end);
  const rep = String(replacement ?? "");
  const trimmedAfter = rep.endsWith(" ") && after.startsWith(" ") ? after.slice(1) : after;
  const next = before + rep + trimmedAfter;
  return { text: next, caret: before.length + rep.length };
}

export async function scanProjectFiles(cwd, limit = 400, execFn = null) {
  if (!cwd) return [];
  if (execFn) {
    try {
      const r = await execFn("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"], { timeout: 6000 });
      if (r?.code === 0 && r.stdout) {
        const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, limit);
        if (lines.length) {
          return lines.map((relPath) => ({
            relPath: relPath.replace(/\\/g, "/"),
            absPath: joinPath(cwd, relPath),
            isImage: isImagePath(relPath),
          }));
        }
      }
    } catch {}
  }

  // Fallback pure fs/promises walk (works in both Node and Herdr).
  const out = [];
  const queue = [{ dir: cwd, prefix: "", depth: 0 }];
  while (queue.length && out.length < limit) {
    const cur = queue.shift();
    let entries = [];
    try {
      entries = await readdir(cur.dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      if (out.length >= limit) break;
      if (typeof name !== "string" || !name) continue;
      if (IGNORED_DIRS.has(name)) continue;
      const rel = cur.prefix ? `${cur.prefix}/${name}` : name;
      const abs = joinPath(cur.dir, name);
      let isDir = false;
      if (cur.depth < 5) {
        try {
          await readdir(abs);
          isDir = true;
        } catch {
          isDir = false;
        }
      }
      if (isDir) {
        queue.push({ dir: abs, prefix: rel, depth: cur.depth + 1 });
      } else {
        out.push({ relPath: rel, absPath: abs, isImage: isImagePath(rel) });
      }
    }
  }
  return out;
}
