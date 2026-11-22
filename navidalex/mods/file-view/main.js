// The right panel's file viewer, and the panel's own opener.
//
// - Shows the file the chat (any-chat) or anything else asks for through shared "view.open"
//   ({ path, at }): a raster preview, rendered Markdown, or read-only source.
//   Visible text refreshes automatically. Recent files are a click away.
// - Opens the right panel (layout node "panel") only when there is something to see: a file
//   opened, or git changes in the focused agent's repository; collapses it again when there is
//   nothing. Closed by hand, it stays closed until something new shows up.
// Props: { stack, self, changes } (the panel's stack id, this block's id, the Changes block's id).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { appHome, checking, exec, focused, layout, panes, props, readTextFile, run, settings, setShared, shared, spaces, theme } from "herdr";
import { mkdir, unlink } from "fs/promises";

const OPEN = "view.open";
const RECENT = "view.recent";
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html", ps1: "bash", sh: "bash" };
const MAX_CHARS = 100000;
const RASTER = /\.(png|jpe?g|bmp|gif)$/i;
const NO_PREVIEW = /\.(webp|svg|ico|tiff?|avif|heic|pdf|zip|7z|rar|gz|exe|dll|docx?|xlsx?|pptx?|mp[34]|mkv|webm|wav|sqlite3?)$/i;
const CACHE = "data/file-view-previews";
let previewId = 0;

// The renderer loads assets from app home, not arbitrary user files. Stage a
// downscaled PNG, never the original. Only hex digits cross into the PS script.
const psPath = (path) => {
  let hex = "";
  for (let i = 0; i < path.length; i++) hex += path.charCodeAt(i).toString(16).padStart(4, "0");
  return `(PathFromHex '${hex}')`;
};
const PS_PATH = `function PathFromHex([string]$hex) {
  -join $(for ($i=0; $i -lt $hex.Length; $i+=4) { [char][Convert]::ToInt32($hex.Substring($i,4),16) })
}`;
const powershell = (script) => exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${PS_PATH}; ${script}`], { timeout: 8000 });
const discard = (preview) => preview && unlink(`${appHome()}/${preview}`).catch(() => {});

async function stageRaster(path) {
  if (!/^[a-z]:[\\/][^:]+$/i.test(path)) throw new Error("Image previews require a local Windows path.");
  const preview = `${CACHE}/${Date.now()}-${++previewId}-${Math.random().toString(36).slice(2, 10)}.png`;
  try {
    await mkdir(`${appHome()}/${CACHE}`, { recursive: true });
    const r = await powershell(`
Add-Type -AssemblyName System.Drawing
$stream = [IO.File]::Open(${psPath(path)}, 'Open', 'Read', 'Read')
try {
  if ($stream.Length -gt 6MB) { 'too-large'; exit 0 }
  $src = [Drawing.Image]::FromStream($stream, $false, $false)
  try {
    if ($src.RawFormat.Guid -notin @([Drawing.Imaging.ImageFormat]::Png.Guid, [Drawing.Imaging.ImageFormat]::Jpeg.Guid, [Drawing.Imaging.ImageFormat]::Bmp.Guid, [Drawing.Imaging.ImageFormat]::Gif.Guid)) { 'unsupported'; exit 0 }
    if ($src.Width -gt 8192 -or $src.Height -gt 8192 -or ([long]$src.Width * $src.Height) -gt 12000000) { 'too-large'; exit 0 }
    $scale = [Math]::Min(1.0, 1280.0 / [Math]::Max($src.Width, $src.Height))
    $w = [Math]::Max(1, [int]($src.Width * $scale)); $h = [Math]::Max(1, [int]($src.Height * $scale))
    $dest = [Drawing.Bitmap]::new($w, $h)
    try {
      $g = [Drawing.Graphics]::FromImage($dest)
      try { $g.InterpolationMode = 'HighQualityBicubic'; $g.DrawImage($src, 0, 0, $w, $h) } finally { $g.Dispose() }
      $dest.Save(${psPath(`${appHome()}/${preview}`)}, [Drawing.Imaging.ImageFormat]::Png)
      Write-Output "$($src.Width) $($src.Height)"
    } finally { $dest.Dispose() }
  } finally { $src.Dispose() }
} finally { $stream.Dispose() }`);
    const result = r.stdout.trim();
    if (result === "too-large") throw new Error("Image too large to preview. Use Open to view the original.");
    if (r.code !== 0 || !/^\d+ \d+$/.test(result)) throw new Error("Image preview unavailable. Use Open to view the original.");
    const [width, height] = result.split(" ").map(Number);
    return { asset: preview, label: `${width} × ${height}`, width, height };
  } catch (error) {
    await discard(preview);
    throw error;
  }
}
// Rows of the Changes view (one per line of the file, plus removed ones), and their height.
const MAX_DIFF_ROWS = 20000;
const ROW_H = 20;
// Unmistakable Git semantic diff palette (independent of monochrome theme ANSI slots).
const GIT_DIFF = {
  addBg: "#2EA04338",
  addBar: "#3FB950",
  addSign: "#56D364",
  addText: "#E6FFEC",
  delBg: "#F8514938",
  delBar: "#F85149",
  delSign: "#FF7B72",
  delText: "#FFDCD7",
  gapBg: "#388BFD1A",
  gapText: "#79C0FF",
  targetBg: "#D2992233",
};

// Repo-relative forward-slash path (handles Windows drive-letter casing differences).
function relToRoot(path, root) {
  const p = String(path ?? "").replace(/\\/g, "/");
  const r = String(root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (r && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p.slice(r.length + 1);
  return p;
}

// Collapse a full-file diff list to only changed hunks with `ctx` context lines around edits.
function compactHunks(rows, ctx = 3) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind === "+" || rows[i].kind === "-") {
      const from = Math.max(0, i - ctx);
      const to = Math.min(rows.length - 1, i + ctx);
      for (let k = from; k <= to; k++) keep[k] = 1;
    }
  }
  const out = [];
  let skipping = false;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipping && out.length) out.push({ kind: "gap" });
      skipping = false;
      out.push(rows[i]);
    } else {
      skipping = true;
    }
  }
  return out;
}

// A unified diff as rows { kind: "+" | "-" | " " | "gap", num, text }.
function parseUnified(out) {
  const rows = [];
  let old = 0, next = 0, inHunk = false;
  for (const line of out.split(/\r?\n/)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { if (rows.length) rows.push({ kind: "gap" }); old = Number(h[1]); next = Number(h[2]); inHunk = true; continue; }
    if (!inHunk || line.startsWith("\\")) continue;
    const sign = line[0], text = line.slice(1);
    if (sign === "+") rows.push({ kind: "+", num: next++, text });
    else if (sign === "-") rows.push({ kind: "-", num: old++, text });
    else if (sign === " ") { old++; rows.push({ kind: " ", num: next++, text }); }
    if (rows.length >= MAX_DIFF_ROWS) break;
  }
  return rows;
}

// The file's changes against git's HEAD: { rows, tracked } or null when there's no git,
// no HEAD commit, or no change. Untracked files return tracked: false so an explicit edit diff
// from chat (`this.given`, with real red/green hunks) is never overwritten by an all-green list.
async function gitRows(path, text) {
  const dir = path.replace(/[\\/][^\\/]*$/, "");
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir }).catch(() => null);
  if (top?.code !== 0) return null;
  const root = top.stdout.trim();
  const rel = relToRoot(path, root);
  const head = await exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  if (head.code !== 0) return null;
  const tracked = await exec("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: root });
  if (tracked.code !== 0) {
    return { tracked: false, rows: text.split(/\r?\n/).slice(0, MAX_DIFF_ROWS).map((t, k) => ({ kind: "+", num: k + 1, text: t })) };
  }
  const d = await exec("git", ["--no-optional-locks", "diff", "--no-color", "--no-ext-diff", "-U99999", "HEAD", "--", rel], { cwd: root, timeout: 5000 });
  if (d.code !== 0 || !d.stdout.trim()) return null;
  return { tracked: true, rows: parseUnified(d.stdout) };
}
const REQUEST_POLL_MS = 400;
const POLL_MS = 3000;
// Untracked files beyond this are taken as a home folder or build output, not an agent's work.
const UNTRACKED_NOISE = 60;

const base = (p) => String(p ?? "").split(/[\\/]/).pop();
const isMarkdown = (p) => /\.(md|markdown|mdx)$/i.test(p ?? "");

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const r = findNode(c, id); if (r) return r; }
  return null;
}

// The folder of the agent (or terminal) in focus.
function focusCwd() {
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return pane?.cwd || f?.cwd || spaces().find((s) => s.active)?.folder || null;
}

export default class FileView extends View {
  init(_props, cx) {
    this.path = null;
    this.text = null;
    this.error = null;
    this.mode = "rendered";
    this.hunksOnly = false;
    this.userPinnedMode = false;
    this.diffScroll = typeof VirtualListScrollHandle !== "undefined" ? VirtualListScrollHandle?.new?.() ?? null : null;
    this.code = null;
    this.changes = 0;
    this.revision = 0;
    this.seenOpen = shared(OPEN)?.at ?? 0;
    if (checking()) return;
    this.content = "";      // what the panel has to show, as a signature
    this.closedOn = null;   // the signature the person closed the panel on
    this.weOpened = false;
    // A click in chat should not wait for the next preview refresh or repository scan.
    cx.timer.every(REQUEST_POLL_MS, (cx) => this.takeOpen(cx));
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    this.poll(cx);
  }

  panel() {
    return findNode(layout(), "panel");
  }

  // A new file asked for (shared "view.open"): show it, open the panel on this tab.
  takeOpen(cx) {
    const req = shared(OPEN);
    if (!req?.path || req.at === this.seenOpen) return;
    this.seenOpen = req.at;
    const rows = Array.isArray(req.rows) && req.rows.length ? req.rows.slice(0, MAX_DIFF_ROWS) : null;
    const line = Number.isInteger(req.line) && req.line > 0 ? req.line : null;
    this.show(req.path, cx, rows, line);
    const recent = [req.path, ...((shared(RECENT) ?? []).filter((p) => p !== req.path))].slice(0, 8);
    setShared(RECENT, recent);
    const { stack = "panel-body", self = "viewer" } = props() ?? {};
    run("layout.show", { id: "panel" });
    run("layout.select", { stack, child: self });
    this.weOpened = true;
    this.closedOn = null;
  }

  resetPreview() {
    this.revision++;
    this.loading = null;
    this.text = this.rows = this.error = this.note = null;
    this.targetLine = null;
    this.truncated = false;
    this.code?.release?.();
    this.code = null;
    discard(this.raster?.asset);
    this.raster = null;
  }

  close() { this.resetPreview(); }

  show(path, cx, rows = null, line = null) {
    this.resetPreview();
    this.path = path;
    this.given = rows;
    this.targetLine = line;
    this.userPinnedMode = false;
    this.hunksOnly = false;
    this.mode = line ? "source" : (isMarkdown(path) ? "rendered" : "source");
    this.wantChanges = true;
    this.load(cx);
    cx.notify();
  }

  load(cx) {
    const path = this.path, revision = this.revision;
    if (!path || this.loading === revision) return;
    this.loading = revision;
    cx.spawn(async (cx) => {
      try {
        if (RASTER.test(path)) {
          const raster = await stageRaster(path);
          if (revision !== this.revision) { await discard(raster.asset); return; }
          this.raster = raster;
          cx.notify();
          return;
        }
        if (NO_PREVIEW.test(path)) {
          this.note = "No preview for this format. Use Open to view the file.";
          cx.notify();
          return;
        }
        // Herdr reads off the UI thread and limits UTF-8 input to 1 MiB.
        const text = await readTextFile(path);
        if (revision !== this.revision) return;
        if (text === null) throw new Error("File not found or unavailable for preview.");
        if (text.includes("\0")) throw new Error("Binary file: no preview. Use Open to view the file.");
        const truncated = text.length > MAX_CHARS;
        const prefix = truncated ? text.slice(0, MAX_CHARS) : text;
        if (!this.error && prefix === this.text && truncated === this.truncated) return;
        this.error = null;
        this.text = prefix;
        this.truncated = truncated;
        this.code?.release?.();
        this.code = this.makeEditor();
        cx.notify();
        const hadRows = Boolean(this.rows?.length);
        const git = truncated ? null : await gitRows(path, prefix).catch(() => null);
        if (revision !== this.revision) return;
        const rows = git?.tracked ? git.rows : (this.given?.length ? this.given : git?.rows ?? null);
        this.rows = rows?.length ? rows : null;
        if (this.rows && (this.wantChanges || (!hadRows && !this.userPinnedMode))) this.mode = "changes";
        if (!this.rows && this.mode === "changes") this.mode = isMarkdown(path) ? "rendered" : "source";
        this.wantChanges = false;
        if (this.mode === "changes" && this.rows && this.targetLine && this.diffScroll?.scroll_to_item) {
          const idx = this.rows.findIndex((r) => r.kind !== "-" && r.num === this.targetLine);
          if (idx >= 0) try { this.diffScroll.scroll_to_item(idx, "center"); } catch {}
        }
        cx.notify();
      } catch (error) {
        if (revision !== this.revision) return;
        this.text = this.rows = null;
        this.code?.release?.();
        this.code = null;
        this.error = RASTER.test(path) ? (error.message ?? "Image preview unavailable.") : "Text preview unavailable (file missing, too large, or not UTF-8). Use Open to view the original.";
        cx.notify();
      } finally {
        if (this.loading === revision) this.loading = null;
      }
    });
  }

  makeEditor() {
    if (this.text === null) return null;
    const t = theme(), ext = (base(this.path).split(".").pop() || "txt").toLowerCase();
    const ed = EditorState.new({ language: LANG[ext] ?? ext, readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    if (this.targetLine && ed?.set_selected_range) {
      const lines = this.text.split("\n");
      const idx = Math.max(0, Math.min(lines.length - 1, this.targetLine - 1));
      let start = 0;
      for (let i = 0; i < idx; i++) start += lines[i].length + 1;
      const end = start + (lines[idx]?.length ?? 0);
      try { ed.set_selected_range({ start, end }); } catch {}
    }
    return ed;
  }

  // Every few seconds: requests, the open file, the repo's changes, and whether the panel shows.
  poll(cx) {
    this.takeOpen(cx);
    const panel = this.panel();
    const selected = findNode(panel, props()?.stack ?? "panel-body")?.active;
    if (this.path && !this.error && panel && !panel.hidden && (!selected || selected === (props()?.self ?? "viewer")) && !RASTER.test(this.path) && !NO_PREVIEW.test(this.path)) this.load(cx);
    if (this.polling || Date.now() < (this.nextStatus ?? 0)) return;
    this.polling = true;
    this.nextStatus = Date.now() + 12000;
    // Re-render only when the scan changes what the viewer shows, not on every tick.
    const before = this.scanSignature();
    cx.spawn(async (cx) => {
      try {
        const cwd = focusCwd();
        let changed = [], repo = null;
        if (cwd) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
          if (focusCwd() !== cwd) return;
          if (top.code === 0) {
            repo = top.stdout.trim();
            const head = await exec("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: repo });
            if (focusCwd() !== cwd) return;
            const st = await exec("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"], { cwd: repo });
            if (focusCwd() !== cwd || st.code !== 0) return;
            const lines = st.stdout.split(/\r?\n/).filter(Boolean);
            const tracked = lines.filter((l) => !l.startsWith("??"));
            const untracked = lines.filter((l) => l.startsWith("??"));
            // A repo with no commit (a home folder) or a flood of untracked files is noise.
            changed = head.code !== 0 ? tracked : untracked.length > UNTRACKED_NOISE ? tracked : lines;
          }
        }
        this.changes = changed.length;
        this.decide(changed, repo);
      } finally {
        this.polling = false;
        if (this.scanSignature() !== before) cx.notify();
      }
    });
  }

  scanSignature() {
    return `${this.changes}\u0000${this.content}`;
  }

  // Opens the panel when there is something new to see, collapses it when there's nothing.
  decide(changed, repo) {
    this.repoContent = changed.length ? JSON.stringify([null, repo, changed]) : "";
    const content = this.path ? JSON.stringify([this.path, changed.length ? repo : null, changed]) : this.repoContent;
    const node = this.panel();
    if (!node) return;
    const shown = !node.hidden;
    if (!content) {
      if (shown && this.weOpened) run("layout.hide", { id: "panel" });
      this.weOpened = false;
      this.closedOn = null;
    } else if (content !== this.content) {
      // Something new: show it, unless the person closed the panel on this very content.
      if (!shown && content !== this.closedOn) {
        run("layout.show", { id: "panel" });
        if (!this.path) run("layout.select", { stack: props()?.stack ?? "panel-body", child: props()?.changes ?? "changes" });
        this.weOpened = true;
      }
    } else if (!shown && this.lastShown) {
      // Closed by hand: remember what it was showing.
      this.closedOn = content;
      this.weOpened = false;
    }
    this.lastShown = !node.hidden;
    this.content = content;
  }

  changeCounts() {
    const add = (this.rows ?? []).filter((r) => r.kind === "+").length;
    const del = (this.rows ?? []).filter((r) => r.kind === "-").length;
    return { add, del };
  }

  changeLabel() {
    const { add, del } = this.changeCounts();
    return `Changes +${add} −${del}`;
  }

  // The file with its Git changes: green added lines, red removed lines, left gutter bar, virtualized.
  diffBody(t) {
    const rows = this.hunksOnly ? compactHunks(this.rows, 3) : this.rows;
    const font = settings().font_family ?? "JetBrains Mono";
    const row = (r) => {
      if (r.kind === "gap") {
        return h_flex().h(ROW_H).w_full().px(10).items_center().bg(GIT_DIFF.gapBg)
          .text_size(11).text_color(GIT_DIFF.gapText).child("⋯  unchanged lines hidden");
      }
      const add = r.kind === "+", del = r.kind === "-";
      const isTarget = Boolean(this.targetLine) && !del && r.num === this.targetLine;
      return h_flex().h(ROW_H).w_full().items_center()
        .when(add, (el) => el.bg(GIT_DIFF.addBg))
        .when(del, (el) => el.bg(GIT_DIFF.delBg))
        .when(!add && !del && isTarget, (el) => el.bg(GIT_DIFF.targetBg))
        .child(div().w(3).h_full().flex_none().when(add, (el) => el.bg(GIT_DIFF.addBar)).when(del, (el) => el.bg(GIT_DIFF.delBar)))
        .child(div().w(44).flex_none().pr(8).text_size(11)
          .text_color(add ? GIT_DIFF.addSign : del ? GIT_DIFF.delSign : t.dim)
          .text_right().child(r.num ? String(r.num) : ""))
        .child(div().w(16).flex_none().font_semibold()
          .text_color(add ? GIT_DIFF.addSign : del ? GIT_DIFF.delSign : t.dim)
          .child(add ? "+" : del ? "−" : " "))
        .child(div().flex_1().min_w(0).truncate()
          .text_color(add ? GIT_DIFF.addText : del ? GIT_DIFF.delText : t.foreground)
          .child(r.text || " "));
    };
    const list = v_virtual_list("fv-diff", rows.length, ROW_H, (i) => String(i),
      (range) => rows.slice(range.start, range.end).map(row)).size_full();
    return div().flex_1().min_h(0).font_family(font).text_size(12.5)
      .child(this.diffScroll ? list.track_scroll(this.diffScroll) : list);
  }

  btn(t, id, label, onClick, active = false) {
    return div().id(id).px(8).py(3).rounded(6).text_size(11.5).cursor_pointer().flex_none()
      .bg(active ? t.selected : t.surface).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme();
    const recent = (shared(RECENT) ?? []).filter((p) => p !== this.path);
    const md = isMarkdown(this.path);
    const head = h_flex().h(32).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(this.path ? (this.targetLine ? `${base(this.path)}:${this.targetLine}` : base(this.path)) : "Viewer"))
      .child(this.btn(t, "fv-close", "×", (_e, cx) => {
        this.path = null;
        this.resetPreview();
        this.closedOn = this.repoContent ?? "";
        this.weOpened = this.lastShown = false;
        run("layout.hide", { id: "panel" });
        cx.notify();
      }).tooltip("Close viewer"));
    const counts = this.rows ? this.changeCounts() : null;
    const actions = h_flex().h(32).min_w(0).flex_none().px(10).gap(6).items_center().overflow_x_scrollbar()
      .when(Boolean(this.rows), (el) => el
        .child(h_flex().id("fv-changes").px(8).py(3).gap(5).rounded(6).text_size(11.5).cursor_pointer().flex_none().items_center()
          .bg(this.mode === "changes" ? t.selected : t.surface)
          .text_color(this.mode === "changes" ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.mode = "changes"; this.userPinnedMode = false; cx.notify(); })
          .child("Git diff")
          .when(counts.add > 0, (c) => c.child(div().font_semibold().text_color(GIT_DIFF.addSign).child(`+${counts.add}`)))
          .when(counts.del > 0, (c) => c.child(div().font_semibold().text_color(GIT_DIFF.delSign).child(`−${counts.del}`))))
        .when(this.mode === "changes", (c) => c
          .child(this.btn(t, "fv-hunks", this.hunksOnly ? "Full file" : "Only changes", (_e, cx) => { this.hunksOnly = !this.hunksOnly; cx.notify(); }, this.hunksOnly))))
      .when(!md && Boolean(this.rows), (el) => el
        .child(this.btn(t, "fv-source-plain", "Source", (_e, cx) => { this.mode = "source"; this.userPinnedMode = true; cx.notify(); }, this.mode === "source")))
      .when(md, (el) => el
        .child(this.btn(t, "fv-rendered", "Rendered", (_e, cx) => { this.mode = "rendered"; this.userPinnedMode = true; cx.notify(); }, this.mode === "rendered"))
        .child(this.btn(t, "fv-source", "Source", (_e, cx) => { this.mode = "source"; this.userPinnedMode = true; cx.notify(); }, this.mode === "source")))
      .when(Boolean(this.path) && (this.error || RASTER.test(this.path)), (el) => el.child(this.btn(t, "fv-reload", "Reload", (_e, cx) => this.show(this.path, cx, this.given))))
      .child(this.btn(t, "fv-open", "Open", (_e, cx) => { const path = this.path; cx.spawn(async () => { await powershell(`Invoke-Item -LiteralPath ${psPath(path)}`); }); }));
    let body;
    if (!this.path) {
      body = v_flex().flex_1().p(16).gap(8).text_size(12.5).text_color(t.dim)
        .child(div().child("Click a file in the chat to open it here."))
        .child(div().child(this.changes ? `${this.changes} changed files: see Changes.` : "No changes in this repository."));
    } else if (this.error) {
      body = div().p(16).text_size(12.5).text_color(t.blocked).child(this.error);
    } else if (this.note) {
      body = div().p(16).text_size(12.5).text_color(t.dim).child(this.note);
    } else if (this.raster) {
      const { asset, label, width, height } = this.raster;
      const scale = Math.min(1, Math.max(1, (this.viewerWidth ?? 300) - 28) / width, 480 / height);
      body = v_flex().id("fv-image").flex_1().min_h(0).p(12).gap(6).items_center().overflow_y_scrollbar()
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(image(asset).w(Math.max(1, Math.round(width * scale))).h(Math.max(1, Math.round(height * scale))).flex_none());
    } else if (this.text === null) {
      body = div().p(16).text_size(12.5).text_color(t.dim).child("Loading…");
    } else if (this.mode === "changes" && this.rows) {
      body = this.diffBody(t);
    } else if (md && this.mode === "rendered") {
      body = v_flex().id("fv-md").flex_1().min_h(0).overflow_y_scrollbar().px(18).py(14).text_size(15).line_height(1.55)
        .text_color(t.foreground).child(TextView.markdown(`fv-${this.path}`, this.text).selectable(true));
    } else {
      body = this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(16).text_size(12.5).text_color(t.dim).child("Loading…");
    }
    return v_flex().id("file-view").size_full().bg(t.background)
      .on_size_change((size, cx) => { if (this.viewerWidth !== size.width) { this.viewerWidth = size.width; if (this.raster) cx.notify(); } })
      .child(head)
      .when(Boolean(this.path), (el) => el.child(actions).child(div().px(10).py(4).truncate().text_size(11).text_color(t.dim).child(this.path)))
      .when(this.truncated, (el) => el.child(div().px(10).py(4).text_size(11).text_color(t.dim).child("Partial preview · Open to see the full file")))
      .child(body)
      .when(recent.length > 0, (el) => el.child(v_flex().flex_none().px(10).py(6).gap(2).border_t(1).border_color(t.border)
        .child(div().text_size(10.5).text_color(t.dim).child("RECENT"))
        .children(recent.slice(0, 5).map((p, k) => div().id(`fv-r-${k}`).truncate().text_size(12).text_color(t.muted).cursor_pointer()
          .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.show(p, cx); cx.notify(); }).child(base(p))))));
  }
}
