import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { Buffer } from "buffer";

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const normSlash = (p) => String(p ?? "").replace(/\\/g, "/");
const trimEndSlash = (p) => normSlash(p).replace(/\/+$/, "");
const baseName = (p) => normSlash(p).split("/").filter(Boolean).pop() ?? "";
const extOf = (p) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(p ?? ""));
  return m ? m[1].toLowerCase() : "png";
};
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Pure-JS 64-bit FNV-1a hex hash (works in both Node and Herdr's QuickJS runtime).
export function shortHash(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  const s = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c + i) & 0xff), 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function isImagePath(p) {
  return IMAGE_EXT_RE.test(String(p ?? "").trim().replace(/^["'`]|["'`]$/g, ""));
}

export function joinPath(base, rel) {
  const a = trimEndSlash(base);
  const b = normSlash(rel).replace(/^\/+/, "");
  return a ? `${a}/${b}` : b;
}

export function resolveImagePath(raw, cwd) {
  const cleaned = String(raw ?? "").trim().replace(/^["'`(<[]+|["'`)>,.;:]+$/g, "");
  if (!cleaned || !isImagePath(cleaned)) return null;
  if (/^[a-zA-Z]:[\\/]/.test(cleaned) || cleaned.startsWith("/")) {
    return normSlash(cleaned);
  }
  if (!cwd) return null;
  return joinPath(cwd, cleaned.replace(/^\.\//, ""));
}

const IMAGE_PATH_PATTERNS = [
  /"([a-zA-Z]:[\\/][^"\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))"/gi,
  /\[Image:\s*([^\]]+?\.(?:png|jpe?g|gif|webp|bmp))\]/gi,
  /`([^`\r\n]+?\.(?:png|jpe?g|gif|webp|bmp))`/gi,
  /(?:^|[\s(])([a-zA-Z]:[\\/][^\s"'`()[\]<>]+?\.(?:png|jpe?g|gif|webp|bmp))/gi,
  /(?:^|[\s(])((?:\.\.?[\\/])?(?:[\w.\-]+[\\/])*[\w.\-]+\.(?:png|jpe?g|gif|webp|bmp))(?=$|[\s),.;:])/gi,
];

export function extractImagePaths(text, cwd) {
  const s = String(text ?? "");
  if (!s) return [];
  const rawMatches = [];
  for (const re of IMAGE_PATH_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      rawMatches.push({ index: m.index, raw: m[1] });
    }
  }
  rawMatches.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const { raw } of rawMatches) {
    const absPath = resolveImagePath(raw, cwd);
    if (!absPath) continue;
    const key = absPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, absPath, name: baseName(absPath) });
  }
  return out;
}

export function relativeToAppHome(absPath, homeDir) {
  if (!absPath || !homeDir) return null;
  const target = normSlash(absPath);
  const root = `${trimEndSlash(homeDir)}/`;
  if (target.toLowerCase().startsWith(root.toLowerCase())) {
    return target.slice(root.length);
  }
  return null;
}

export async function stageImageFile(absPath, homeDir) {
  const normalized = normSlash(absPath);
  const existingRel = relativeToAppHome(normalized, homeDir);
  if (existingRel) {
    return { absPath: normalized, relPath: existingRel, name: baseName(normalized) };
  }
  const bytes = await readFile(absPath);
  const ext = extOf(normalized);
  const hash = shortHash(`${normalized}|${bytes.length}|${bytes.slice(0, 256).toString("base64")}`);
  const relPath = `data/any-chat/inline-images/${hash}.${ext}`;
  const dest = joinPath(homeDir, relPath);
  await mkdir(joinPath(homeDir, "data/any-chat/inline-images"), { recursive: true });
  try {
    await readFile(dest);
  } catch {
    await writeFile(dest, bytes);
  }
  return { absPath: dest, relPath, name: baseName(normalized) || `${hash}.${ext}` };
}

export async function cacheBase64Image(base64, mimeType, homeDir) {
  const clean = String(base64 ?? "").replace(/^data:[^;]+;base64,/, "").trim();
  if (!clean || !homeDir) return null;
  const ext = MIME_TO_EXT[String(mimeType ?? "").toLowerCase()] ?? "png";
  const hash = shortHash(`${ext}|${clean.length}|${clean.slice(0, 512)}|${clean.slice(-256)}`);
  const relPath = `data/any-chat/inline-images/${hash}.${ext}`;
  const dest = joinPath(homeDir, relPath);
  await mkdir(joinPath(homeDir, "data/any-chat/inline-images"), { recursive: true });
  try {
    await readFile(dest);
  } catch {
    await writeFile(dest, Buffer.from(clean, "base64"));
  }
  return { absPath: dest, relPath, name: `${hash}.${ext}` };
}

export async function extractMessageImages(content, homeDir) {
  if (!Array.isArray(content) || !homeDir) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== "image") continue;
    const data = b.data ?? b.source?.data ?? null;
    const mime = b.mimeType ?? b.source?.media_type ?? "image/png";
    if (!data) continue;
    try {
      const staged = await cacheBase64Image(data, mime, homeDir);
      if (staged) out.push(staged);
    } catch {}
  }
  return out;
}

export async function stageDroppedPaths(paths, homeDir) {
  const images = [];
  const files = [];
  const dir = joinPath(homeDir, "pi-images");
  let madeDir = false;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  let idx = 0;

  for (const raw of paths ?? []) {
    const p = String(raw ?? "").trim();
    if (!p) continue;
    if (!isImagePath(p)) {
      files.push(p);
      continue;
    }
    const existingRel = relativeToAppHome(p, homeDir);
    if (existingRel && existingRel.startsWith("pi-images/")) {
      images.push({ absPath: normSlash(p), relPath: existingRel, name: baseName(p) });
      continue;
    }
    try {
      const bytes = await readFile(p);
      if (!madeDir) {
        await mkdir(dir, { recursive: true });
        madeDir = true;
      }
      idx += 1;
      const safeName = baseName(p).replace(/[^\w.\-]/g, "_") || `drop-${idx}.${extOf(p)}`;
      const name = `${stamp}-${idx}-${safeName}`;
      const relPath = `pi-images/${name}`;
      const dest = joinPath(homeDir, relPath);
      await writeFile(dest, bytes);
      images.push({ absPath: dest, relPath, name });
    } catch {}
  }
  return { images, files };
}

export async function listRecentImages(homeDir, limit = 20) {
  if (!homeDir) return [];
  const dir = joinPath(homeDir, "pi-images");
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const filtered = names
    .filter((n) => typeof n === "string" && isImagePath(n))
    // Timestamped names (clip-YYYYMMDD-HHmmss-fff.png / YYYYMMDD...) sort newest-first lexically.
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);
  return filtered.map((name) => ({
    name,
    relPath: `pi-images/${name}`,
    absPath: joinPath(homeDir, `pi-images/${name}`),
  }));
}

export function buildClipboardPasteCommand(targetDir) {
  const winDir = String(targetDir).replace(/\//g, "\\");
  return `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$d=${psQuote(winDir)}; $stamp=[DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $p = Join-Path $d ("clip-$stamp.png")
  [Windows.Forms.Clipboard]::GetImage().Save($p, [Drawing.Imaging.ImageFormat]::Png); $p
} elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $i=0; foreach ($f in [Windows.Forms.Clipboard]::GetFileDropList()) {
    if ($f -match '\\.(png|jpe?g|gif|webp|bmp)$') {
      $i++; $safe = ([IO.Path]::GetFileName($f) -replace '[^\\w.\\-]','_')
      $p = Join-Path $d ("$stamp-$i-$safe")
      Copy-Item -LiteralPath $f -Destination $p; $p
    }
  }
}`.trim();
}

export async function captureClipboardImages(homeDir, execFn) {
  if (!homeDir || !execFn) return [];
  const dir = joinPath(homeDir, "pi-images");
  await mkdir(dir, { recursive: true });
  const script = buildClipboardPasteCommand(dir);
  const r = await execFn("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 15000 });
  if (!r || r.code !== 0) return [];
  const saved = String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of saved) {
    const relPath = relativeToAppHome(p, homeDir) ?? `pi-images/${baseName(p)}`;
    out.push({ absPath: normSlash(p), relPath, name: baseName(p) });
  }
  return out;
}
