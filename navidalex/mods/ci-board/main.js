import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import os from "os";
import { spaces, panes, focused, exec, theme, notify, nextCommand, checking } from "herdr";

// CI board: the focused space's GitHub repo at a glance (an own build inspired by Forge).
// Workflow runs, open pull requests (with their checks) and releases, read with `gh --json`.
// Read-only towards GitHub, except the explicit "Rerun failed" button (asks first, inline).
// Polls every 30 s while a run is queued or in progress, otherwise every 120 s; refreshes when
// the focused space/folder changes. The spinner is native (`frames`), never a timer.

const WIN = /^win/.test(os.platform());
// my-status calls `gh` straight from the mod PATH; this is the installer's location in case it isn't.
const GH_WIN = "C:\\Program Files\\GitHub CLI\\gh.exe";
const FAST = 30000, SLOW = 120000;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
const ROW = 40;

const RUN_FIELDS = "databaseId,displayTitle,workflowName,headBranch,status,conclusion,createdAt,url,event";
const PR_FIELDS = "number,title,headRefName,isDraft,reviewDecision,statusCheckRollup,url,author";
const REL_FIELDS = "tagName,name,isLatest,isDraft,isPrerelease,publishedAt";

// Where the board looks: the focused pane's live folder, else the space's (as `changes` does).
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, on };
}
const key = () => JSON.stringify(location());

async function gh(args, cwd, on) {
  const opts = { cwd, on, timeout: 30000 };
  try { return await exec("gh", args, opts); }
  catch (e) {
    if (!on && WIN) return await exec(GH_WIN, args, opts);
    throw e;
  }
}

const firstLine = (r) => ((r?.stderr || r?.stdout || "").trim().split("\n")[0] || "").trim();

// gh's JSON list, or { error } when gh refused or printed something else.
async function ghList(args, cwd, on) {
  try {
    const r = await gh(args, cwd, on);
    if (r.code !== 0) return { error: firstLine(r) || `gh exited with ${r.code}` };
    return { list: JSON.parse(r.stdout.trim() || "[]") };
  } catch (e) { return { error: String(e) }; }
}

function ago(iso) {
  const ms = Date.parse(iso ?? "");
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

// A run's state: running | success | failure | blocked | dim.
function runKind(r) {
  if (ACTIVE.has(r.status)) return "running";
  switch (r.conclusion) {
    case "success": return "success";
    case "failure": case "timed_out": case "startup_failure": return "failure";
    case "action_required": return "blocked";
    default: return "dim"; // cancelled, skipped, neutral, stale
  }
}

// A PR's checks rolled up: { kind, passed, failed, pending, total }.
function checksOf(rollup) {
  const out = { kind: null, passed: 0, failed: 0, pending: 0, total: 0 };
  for (const c of rollup ?? []) {
    out.total++;
    if (c.__typename === "StatusContext" || (c.state && !c.status)) {
      const s = String(c.state ?? "").toUpperCase();
      if (s === "SUCCESS") out.passed++;
      else if (s === "FAILURE" || s === "ERROR") out.failed++;
      else out.pending++;
    } else if (String(c.status ?? "").toUpperCase() !== "COMPLETED") out.pending++;
    else {
      const k = String(c.conclusion ?? "").toUpperCase();
      if (k === "SUCCESS" || k === "NEUTRAL" || k === "SKIPPED") out.passed++;
      else if (k === "CANCELLED" || k === "STALE") { /* counted in total only */ }
      else out.failed++;
    }
  }
  out.kind = !out.total ? null : out.failed ? "failure" : out.pending ? "running" : out.passed ? "success" : "dim";
  return out;
}

const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

export default class CiBoard extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.context = null;
    this.reset();
    this.rerunning = new Set();
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "refresh") this.refresh(cx);
        cx.notify();
      }
    });
    if (checking()) return; // no gh/git during `herdr-app check`
    this.refresh(cx);
    cx.timer.every(FAST, (cx) => {
      const busy = this.runs.some((r) => ACTIVE.has(r.status));
      if (Date.now() - this.fetchedAt >= (busy ? FAST - 1000 : SLOW - 1000)) this.refresh(cx);
    });
  }

  reset() {
    this.root = null; this.repo = null; this.branch = null; this.error = null;
    this.runs = []; this.prs = []; this.releases = []; this.sectionErrors = {};
    this.fetchedAt = 0; this.confirm = null; this.loaded = false;
  }

  refresh(cx) {
    if (this.loading || checking()) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!cwd) { this.error = { title: "No folder", detail: "Focus a space with a terminal in a GitHub repository." }; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch((e) => ({ code: 1, stderr: String(e) }));
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.error = { title: "Not a git repository", detail: cwd }; return; }
        const root = top.stdout.trim();
        const br = await exec("git", ["branch", "--show-current"], { cwd: root, on }).catch(() => ({ code: 1, stdout: "" }));
        const branch = br.code === 0 ? br.stdout.trim() || null : null;
        if (!this.repo || this.root !== root) {
          let view;
          try { view = await gh(["repo", "view", "--json", "nameWithOwner,url"], root, on); }
          catch (e) { if (key() === context) this.error = { title: "gh is not available", detail: `${e}\nInstall GitHub CLI and run \`gh auth login\`.` }; return; }
          if (key() !== context) return;
          if (view.code !== 0) { this.root = root; this.error = { title: "No GitHub repository here", detail: firstLine(view) || root }; return; }
          this.repo = JSON.parse(view.stdout);
        }
        const [runs, prs, rels] = await Promise.all([
          ghList(["run", "list", "--limit", "15", "--json", RUN_FIELDS], root, on),
          ghList(["pr", "list", "--limit", "15", "--json", PR_FIELDS], root, on),
          ghList(["release", "list", "--limit", "5", "--json", REL_FIELDS], root, on),
        ]);
        if (key() !== context) return;
        this.root = root; this.branch = branch; this.error = null; this.loaded = true;
        this.runs = runs.list ?? []; this.prs = prs.list ?? []; this.releases = rels.list ?? [];
        this.sectionErrors = { runs: runs.error, prs: prs.error, releases: rels.error };
        this.fetchedAt = Date.now();
      } catch (e) { if (key() === context) this.error = { title: "Couldn't read the repository", detail: String(e) }; }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // `gh run rerun <id> --failed`, the only write this board makes; asked for inline first.
  rerun(run, cx) {
    const root = this.root, on = location().on, id = String(run.databaseId);
    this.confirm = null;
    this.rerunning.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await gh(["run", "rerun", id, "--failed"], root, on); }
      catch (e) { r = { code: 1, stderr: String(e) }; }
      this.rerunning.delete(id);
      if (r.code === 0) notify({ title: "Rerunning failed jobs", body: `${run.workflowName ?? "Workflow"} · ${run.displayTitle ?? id}`, level: "success", timeout: 4000 });
      else notify({ title: "Couldn't rerun", body: firstLine(r) || `gh exited with ${r.code}`, level: "error" });
      this.fetchedAt = 0;
      this.refresh(cx);
      cx.notify();
    });
  }

  icon(kind, t) {
    const box = () => div().w(16).flex_none().flex().justify_center().text_size(12);
    switch (kind) {
      case "running": return box().text_color(t.working).frames(SPIN, 90);
      case "success": return box().text_color(t.ansi2).child("✓");
      case "failure": return box().text_color(t.ansi1).child("✕");
      case "blocked": return box().text_color(t.blocked).child("!");
      case "dim": return box().text_color(t.dim).child("⊘");
      default: return box();
    }
  }

  section(id, title, count, error, empty, rows, t) {
    return v_flex().flex_none()
      .child(h_flex().h(30).flex_none().px(14).gap(8).items_center().text_size(11).text_color(t.dim)
        .child(div().font_semibold().child(title.toUpperCase()))
        .child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(10).child(String(count))))
      .when(Boolean(error), (el) => el.child(div().id(`${id}-error`).px(14).pb(6).text_size(11).text_color(t.ansi1).truncate().tooltip(error).child(error)))
      .when(!error && !count, (el) => el.child(div().px(14).pb(8).text_size(12).text_color(t.dim).child(empty)))
      .children(rows);
  }

  meta(parts, t) {
    return h_flex().min_w(0).gap(6).text_size(11).text_color(t.dim).children(parts.filter(Boolean).map((p) =>
      typeof p === "string" ? div().flex_none().child(p) : p));
  }

  branchTag(name, t) {
    if (!name) return null;
    const mine = name === this.branch;
    return h_flex().flex_none().max_w(180).gap(3).items_center().text_color(mine ? t.accent : t.muted)
      .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
      .child(div().min_w(0).truncate().when(mine, (e) => e.font_semibold()).child(name));
  }

  runRow(r, t) {
    const id = String(r.databaseId), kind = runKind(r), mine = r.headBranch && r.headBranch === this.branch;
    const confirming = this.confirm === id, rerunning = this.rerunning.has(id);
    const tip = `${r.workflowName ?? ""}: ${r.status}${r.conclusion ? ` · ${r.conclusion}` : ""}\nClick: open in the browser`;
    return h_flex().id(`run-${id}`).h(ROW).flex_none().mx(6).px(8).gap(8).items_center().rounded(7)
      .when(mine, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => cx.open_url(r.url))
      .child(this.icon(kind, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.displayTitle || r.workflowName || id))
        .child(this.meta([r.workflowName, this.branchTag(r.headBranch, t), r.event, ago(r.createdAt)], t)))
      .when(kind === "failure" && !confirming, (el) => el.child(rerunning
        ? div().flex_none().text_size(11).text_color(t.dim).child("rerunning…")
        : div().id(`rerun-${id}`).flex_none().h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.input)
          .text_size(11).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.raised).text_color(t.foreground))
          .tooltip("Rerun the failed jobs (gh run rerun --failed)")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.confirm = id; cx.notify(); })
          .child("Rerun failed")))
      .when(confirming, (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(11)
        .child(div().text_color(t.muted).child("Rerun failed jobs?"))
        .child(div().id(`rerun-yes-${id}`).h(24).px(8).flex().items_center().rounded(6).bg(t.solid).text_color(t.solid_foreground).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.rerun(r, cx); }).child("Rerun"))
        .child(div().id(`rerun-no-${id}`).h(24).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).text_color(t.foreground).cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.confirm = null; cx.notify(); }).child("Cancel"))));
  }

  prRow(p, t) {
    const checks = checksOf(p.statusCheckRollup), mine = p.headRefName && p.headRefName === this.branch;
    const review = REVIEW[p.reviewDecision] ?? null;
    const checkTip = checks.total ? `Checks: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending` : "No checks";
    return h_flex().id(`pr-${p.number}`).h(ROW).flex_none().mx(6).px(8).gap(8).items_center().rounded(7)
      .when(mine, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).cursor_pointer()
      .tooltip(`${checkTip}${review ? ` · ${review}` : ""}\nClick: open in the browser`)
      .on_click((_e, cx) => cx.open_url(p.url))
      .child(this.icon(checks.kind, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center().text_size(12.5)
          .child(div().flex_none().text_color(t.dim).child(`#${p.number}`))
          .child(div().min_w(0).truncate().text_color(p.isDraft ? t.muted : t.foreground).child(p.title ?? "")))
        .child(this.meta([this.branchTag(p.headRefName, t), p.author?.login,
          p.isDraft ? div().flex_none().text_color(t.muted).child("draft") : null,
          review ? div().flex_none().text_color(p.reviewDecision === "APPROVED" ? t.ansi2 : p.reviewDecision === "CHANGES_REQUESTED" ? t.ansi1 : t.dim).child(review) : null,
          checks.total ? `${checks.passed}/${checks.total} checks` : null], t)));
  }

  releaseRow(r, t) {
    const badge = (text, color) => div().flex_none().px(5).rounded(4).border_1().border_color(color).text_size(10).text_color(color).child(text);
    const url = this.repo?.url ? `${this.repo.url}/releases/tag/${encodeURIComponent(r.tagName)}` : null;
    return h_flex().id(`rel-${r.tagName}`).h(ROW).flex_none().mx(6).px(8).gap(8).items_center().rounded(7)
      .hover((s) => s.bg(t.hover)).when(Boolean(url), (e) => e.cursor_pointer().tooltip("Click: open in the browser").on_click((_e, cx) => cx.open_url(url)))
      .child(this.icon(r.isDraft ? "dim" : r.isLatest ? "success" : null, t))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).gap(6).items_center()
          .child(div().flex_none().text_size(12.5).text_color(t.foreground).child(r.tagName))
          .when(Boolean(r.isLatest), (e) => e.child(badge("Latest", t.ansi2)))
          .when(Boolean(r.isPrerelease), (e) => e.child(badge("Pre-release", t.blocked)))
          .when(Boolean(r.isDraft), (e) => e.child(badge("Draft", t.dim))))
        .child(this.meta([r.name && r.name !== r.tagName ? r.name : null, r.isDraft ? "not published" : ago(r.publishedAt)], t)));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme();
    const running = this.runs.filter((r) => ACTIVE.has(r.status)).length;
    const header = h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("CI"))
      .when(Boolean(this.repo), (el) => el.child(div().id("repo").min_w(0).truncate().text_size(12).text_color(t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip(`${this.repo.url}\nClick: open in the browser`)
        .on_click((_e, cx) => cx.open_url(this.repo.url)).child(this.repo.nameWithOwner)))
      .when(Boolean(this.branch), (el) => el.child(this.branchTag(this.branch, t)))
      .child(div().flex_1())
      .when(running > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.working).child(`${running} running`)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(this.loading ? "" : this.fetchedAt ? ago(new Date(this.fetchedAt).toISOString()) : ""))
      .child(div().id("refresh").flex_none().w(24).h(24).flex().items_center().justify_center().rounded(6)
        .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip("Refresh (R)").on_click((_e, cx) => { this.fetchedAt = 0; this.refresh(cx); cx.notify(); })
        .when(this.loading, (e) => e.text_color(t.working).frames(SPIN, 90))
        .when(!this.loading, (e) => e.child("↻")));

    let body;
    if (this.error) {
      body = v_flex().flex_1().min_h(0).p(20).gap(8).items_center().justify_center()
        .child(div().text_size(13).text_color(t.foreground).child(this.error.title))
        .child(div().max_w(320).text_size(11).text_color(t.dim).child(this.error.detail ?? ""))
        .child(div().id("retry").mt(4).h(28).px(12).flex().items_center().rounded(7).border_1().border_color(t.input)
          .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.raised))
          .on_click((_e, cx) => { this.repo = null; this.fetchedAt = 0; this.refresh(cx); cx.notify(); }).child("Retry"));
    } else if (!this.loaded) {
      body = v_flex().flex_1().min_h(0).items_center().justify_center().gap(6).text_color(t.dim)
        .child(div().text_color(t.working).frames(SPIN, 90))
        .child(div().text_size(12).child(checking() ? "CI board" : "Reading GitHub…"));
    } else {
      const e = this.sectionErrors;
      body = div().flex_1().min_h(0).relative()
        .child(v_flex().id("ci-list").absolute().inset_0().overflow_y_scroll().pb(10)
          .child(this.section("runs", "Workflow runs", this.runs.length, e.runs, "No workflow runs", this.runs.map((r) => this.runRow(r, t)), t))
          .child(this.section("prs", "Pull requests", this.prs.length, e.prs, "No open pull requests", this.prs.map((p) => this.prRow(p, t)), t))
          .child(this.section("releases", "Releases", this.releases.length, e.releases, "No releases", this.releases.map((r) => this.releaseRow(r, t)), t)))
        .child(Scrollbar.vertical("ci-list").absolute().inset_0());
    }

    return v_flex().id("ci-board").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((ev, cx) => {
        if (ev.key === "r") { this.fetchedAt = 0; this.refresh(cx); }
        else if (ev.key === "escape" && this.confirm) this.confirm = null;
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .child(header)
      .child(body);
  }
}
