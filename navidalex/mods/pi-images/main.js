// Image tray for coding agents: paste screenshots from the clipboard (Ctrl+V or the button),
// drop files, or pick them; reorder, remove, then insert them — in order — into the agent's
// prompt without submitting it (Pi, Claude Code and Codex take image paths as attachments).
// Images are copied to ~/.config/herdr-app/pi-images so the tray can show them.
// Open with mod.open:pi-images (keys.json binds ctrl-shift-i).

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, exec, run, notify, props, closeOverlay, theme, shared, setShared, appHome } from "herdr";
import * as fs from "fs/promises";

const LIST_KEY = "pi-images.list";
const DIR_NAME = "pi-images";
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function isAgent(a) {
  return Boolean(a?.address);
}

export default class PiImages extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(400, () => this.handle.focus());
    this.sel = 0;
    this.busy = null;
    const f = focused();
    const list = agents();
    this.target = list.find((a) => a.address === f?.terminal)?.address ?? f?.terminal ?? list[0]?.address ?? null;
  }

  dir() {
    return `${appHome().replace(/\\/g, "/")}/${DIR_NAME}`;
  }

  winPath(name) {
    return `${this.dir()}/${name}`.replace(/\//g, "\\");
  }

  items() {
    return shared(LIST_KEY) ?? [];
  }

  save(list) {
    setShared(LIST_KEY, list);
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  // Runs a PowerShell script that prints one saved file path per line.
  async ps(script) {
    const r = await exec("powershell", ["-NoProfile", "-STA", "-Command", script], { timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || "PowerShell failed").trim().slice(0, 300));
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  add(paths) {
    const names = paths.map((p) => p.split(/[\\/]/).pop()).filter(Boolean);
    if (!names.length) return;
    const list = this.items().concat(names.map((name) => ({ name, at: Date.now() })));
    this.save(list);
    this.sel = list.length - 1;
  }

  ingest(cx, label, script) {
    this.busy = label;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(this.dir(), { recursive: true });
        const saved = await this.ps(script);
        if (saved.length) this.add(saved);
        else notify({ title: "No image", body: "Nothing image-like found.", level: "warning", timeout: 2500 });
      } catch (e) {
        notify({ title: "Image import failed", body: String(e?.message ?? e), level: "error" });
      }
      this.busy = null;
      cx.notify();
    });
  }

  paste(cx) {
    const d = q(this.dir().replace(/\//g, "\\"));
    this.ingest(cx, "pasting…", `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$d=${d}; $stamp=[DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')
if ([Windows.Forms.Clipboard]::ContainsImage()) {
  $p = Join-Path $d ("clip-$stamp.png")
  [Windows.Forms.Clipboard]::GetImage().Save($p, [Drawing.Imaging.ImageFormat]::Png); $p
} elseif ([Windows.Forms.Clipboard]::ContainsFileDropList()) {
  $i=0; foreach ($f in [Windows.Forms.Clipboard]::GetFileDropList()) {
    if ($f -match '\\.(png|jpe?g|gif|webp|bmp)$') { $i++; $p = Join-Path $d ("$stamp-$i-" + [IO.Path]::GetFileName($f)); Copy-Item -LiteralPath $f -Destination $p; $p }
  }
}`);
  }

  importFiles(cx, files) {
    const images = files.filter((f) => IMAGE_RE.test(f));
    if (!images.length) {
      notify({ title: "Not an image", body: "Drop PNG, JPG, GIF, WEBP or BMP files.", level: "warning", timeout: 2500 });
      return;
    }
    const d = q(this.dir().replace(/\//g, "\\"));
    this.ingest(cx, "importing…", `
$d=${d}; $stamp=[DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'); $i=0
foreach ($f in @(${images.map(q).join(",")})) { $i++; $p = Join-Path $d ("$stamp-$i-" + [IO.Path]::GetFileName($f)); Copy-Item -LiteralPath $f -Destination $p; $p }`);
  }

  pick(cx) {
    const d = q(this.dir().replace(/\//g, "\\"));
    this.ingest(cx, "picking…", `
Add-Type -AssemblyName System.Windows.Forms
$o = New-Object Windows.Forms.OpenFileDialog
$o.Multiselect = $true; $o.Filter = 'Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp'
if ($o.ShowDialog() -eq 'OK') { $d=${d}; $stamp=[DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff'); $i=0
  foreach ($f in $o.FileNames) { $i++; $p = Join-Path $d ("$stamp-$i-" + [IO.Path]::GetFileName($f)); Copy-Item -LiteralPath $f -Destination $p; $p } }`);
  }

  move(delta, cx) {
    const list = [...this.items()];
    const to = this.sel + delta;
    if (to < 0 || to >= list.length) return;
    [list[this.sel], list[to]] = [list[to], list[this.sel]];
    this.sel = to;
    this.save(list);
    cx.notify();
  }

  remove(i, cx) {
    const list = this.items();
    const gone = list[i];
    this.save(list.filter((_, j) => j !== i));
    this.sel = Math.max(0, Math.min(this.sel, list.length - 2));
    if (gone) cx.spawn(async () => { try { await fs.unlink(`${this.dir()}/${gone.name}`); } catch { /* already gone */ } });
    cx.notify();
  }

  clear(cx) {
    const list = this.items();
    this.save([]);
    this.sel = 0;
    cx.spawn(async () => { for (const it of list) { try { await fs.unlink(`${this.dir()}/${it.name}`); } catch { /* ignore */ } } });
    cx.notify();
  }

  pathsText(list) {
    return list.map((it) => { const p = this.winPath(it.name); return /\s/.test(p) ? `"${p}"` : p; }).join(" ");
  }

  async toClipboard(text) {
    const tmp = `${this.dir()}/.clip.txt`;
    await fs.writeFile(tmp, text, "utf8");
    const r = await exec("powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 -LiteralPath ${q(tmp)})`]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Set-Clipboard failed");
  }

  // Types the paths into the agent's prompt via the clipboard, without pressing Enter.
  insert(cx, { clearAfter }) {
    const list = this.items();
    if (!list.length) return;
    if (!this.target) { notify({ title: "No agent", body: "Pick an agent terminal.", level: "warning" }); return; }
    cx.spawn(async (cx) => {
      try {
        await this.toClipboard(this.pathsText(list) + " ");
        this.close();
        run("pane.focus", { terminal: this.target });
        run("terminal.paste", {});
        notify({ title: "Images inserted", body: `${list.length} image(s) → ${this.target}`, level: "success", timeout: 2000 });
        if (clearAfter) this.save([]);
      } catch (e) {
        notify({ title: "Insert failed", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  }

  copyPaths(cx) {
    cx.spawn(async () => {
      try { await this.toClipboard(this.pathsText(this.items())); notify({ title: "Copied", body: "Image paths copied", level: "success", timeout: 1500 }); }
      catch (e) { notify({ title: "Copy failed", body: String(e?.message ?? e), level: "error" }); }
    });
  }

  btn(t, id, label, onClick, primary = false) {
    return div().id(id).px(10).py(4).rounded(6).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.surface).text_color(primary ? t.solid_foreground : t.muted)
      .hover((s) => s.bg(primary ? t.accent : t.hover).text_color(primary ? t.accent_foreground : t.foreground))
      .on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme();
    const list = this.items();
    if (this.sel >= list.length) this.sel = Math.max(0, list.length - 1);
    const targets = agents().filter(isAgent);
    return v_flex().id("pi-images").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_drop((e, cx) => this.importFiles(cx, e.paths ?? []))
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (e.key === "escape") return this.close();
        if (e.key === "v" && m.control) this.paste(cx);
        else if (e.key === "left") m.shift ? this.move(-1, cx) : (this.sel = Math.max(0, this.sel - 1));
        else if (e.key === "right") m.shift ? this.move(1, cx) : (this.sel = Math.min(list.length - 1, this.sel + 1));
        else if (e.key === "delete" || e.key === "backspace") this.remove(this.sel, cx);
        else if (e.key === "enter") this.insert(cx, { clearAfter: m.shift });
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Images${list.length ? ` (${list.length})` : ""}`))
        .when(Boolean(this.busy), (el) => el.child(div().text_size(11).text_color(t.working).child(this.busy)))
        .child(this.btn(t, "paste", "Paste  Ctrl+V", (_e, cx) => this.paste(cx)))
        .child(this.btn(t, "pick", "Add files…", (_e, cx) => this.pick(cx)))
        .child(this.btn(t, "esc", "Esc", () => this.close())))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).child("Send to"))
        .children(targets.map((a, i) => div().id(`tg-${i}`).px(8).py(3).rounded(6).text_size(11.5).cursor_pointer()
          .bg(a.address === this.target ? t.selected : t.surface).text_color(a.address === this.target ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.target = a.address; cx.notify(); })
          .child(`${a.space_name} · ${a.title || a.app || a.address}`.slice(0, 40)))))
      .child(v_flex().id("tray").h(340).overflow_y_scrollbar().rounded(10).border_1().border_color(t.border).bg(t.background).p(10)
        .when(!list.length, (el) => el.items_center().justify_center()
          .child(div().text_color(t.dim).child("Paste a screenshot (Ctrl+V), drop images here, or Add files…")))
        .child(h_flex().flex_wrap().gap(10).children(list.map((it, i) => {
          const sel = i === this.sel;
          return v_flex().id(`img-${i}`).w(150).gap(4).p(6).rounded(8).cursor_pointer()
            .border_2().border_color(sel ? t.accent : t.border).bg(sel ? t.selected : t.surface)
            .on_click((_e, cx) => { this.sel = i; this.handle.focus(); cx.notify(); })
            .child(div().h(100).w_full().rounded(5).overflow_hidden().bg(t.canvas).flex().items_center().justify_center()
              .child(image(`${DIR_NAME}/${it.name}`).max_w(136).max_h(100)))
            .child(h_flex().gap(4).items_center().text_size(11)
              .child(div().flex_none().px(5).rounded(4).bg(t.accent).text_color(t.accent_foreground).child(String(i + 1)))
              .child(div().flex_1().truncate().text_color(t.muted).child(it.name.replace(/^\d{8}-\d{6}-\d{3}-(\d+-)?/, "")))
              .child(div().id(`l-${i}`).px(3).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.sel = i; this.move(-1, cx); }).child("◀"))
              .child(div().id(`r-${i}`).px(3).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.sel = i; this.move(1, cx); }).child("▶"))
              .child(div().id(`x-${i}`).px(3).text_color(t.dim).hover((s) => s.text_color(t.blocked)).on_click((_e, cx) => this.remove(i, cx)).child("✕")));
        }))))
      .child(div().text_size(11).text_color(t.dim).child("←/→ select · Shift+←/→ reorder · Del remove · Enter insert · Shift+Enter insert & clear"))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1())
        .child(this.btn(t, "clear", "Clear", (_e, cx) => this.clear(cx)))
        .child(this.btn(t, "copy", "Copy paths", (_e, cx) => this.copyPaths(cx)))
        .child(this.btn(t, "insert", "Insert into prompt", (_e, cx) => this.insert(cx, { clearAfter: false }), true)));
  }
}
