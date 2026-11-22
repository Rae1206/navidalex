// Model usage for the chat's footer strip: context used, output tokens, cost, and what is left
// of the plan's rate limits.
//
// - Claude:  transcript `message.usage` (deduped by message id); plan limits from
//            data/my-status/usage.json, written by mods/my-status/statusline.cjs (Claude Code's
//            status line command receives `rate_limits`).
// - Pi:      session `message.usage` (totalTokens, output, cost.total); Anthropic-backed models
//            share the Claude plan, so they show the same limits.
// - Codex:   rollout `event_msg` token_count (last/total usage, context window, rate_limits).
// - OpenCode: not tracked yet.

import { readFile } from "fs/promises";
import { appHome, shared } from "herdr";

export function newUsage() {
  return { ctx: 0, ctxMax: 0, out: 0, cost: 0, model: null, outBy: new Map(), limits: null };
}

// "1M", "1.0M", "200K", "131.1K" → tokens.
function parseSize(s) {
  const m = /^([\d.]+)\s*([KM])?/i.exec(String(s ?? ""));
  if (!m) return 0;
  const unit = m[2]?.toUpperCase();
  return Math.round(parseFloat(m[1]) * (unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1));
}

// Context window of a model ("provider/id" or "id"), preferring live Pi session metadata
// and falling back to pi-models' cached list.
export function contextOf(model, liveModels = null) {
  if (!model) return 0;
  const id = model.split("/").pop();
  const findIn = (list) => {
    if (!Array.isArray(list)) return 0;
    const hit = list.find((m) => m?.ref === model) ?? list.find((m) => m?.id === id);
    if (!hit) return 0;
    if (Number.isFinite(hit.contextWindow) && hit.contextWindow > 0) return hit.contextWindow;
    return parseSize(hit.context);
  };
  return findIn(liveModels) || findIn(shared("pi-models.cache"));
}

function windowName(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "wk";
  if (!minutes) return "limit";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : `${Math.round(minutes / 60)}h`;
}

export function trackUsage(kind, chunk, u) {
  const needle = kind === "codex" ? '"token_count"' : '"usage"';
  for (const line of chunk.split("\n")) {
    if (!line.includes(needle)) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (kind === "claude") {
      const m = e.message;
      if (e.type !== "assistant" || e.isSidechain || !m?.usage) continue;
      const x = m.usage;
      const ctx = (x.input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0) + (x.output_tokens ?? 0);
      if (ctx) u.ctx = ctx;
      // One reply is split over several lines that repeat its usage: count it once.
      u.outBy.set(m.id ?? e.uuid, x.output_tokens ?? 0);
      if (m.model && !m.model.startsWith("<")) u.model = m.model;
    } else if (kind === "pi") {
      const m = e.message;
      if (m?.role !== "assistant" || !m.usage) continue;
      const x = m.usage;
      if (x.totalTokens) u.ctx = x.totalTokens;
      u.out += x.output ?? 0;
      u.cost += x.cost?.total ?? 0;
      if (m.provider && m.model) u.model = `${m.provider}/${m.model}`;
    } else if (kind === "codex") {
      const p = e.payload;
      if (e.type !== "event_msg" || p?.type !== "token_count") continue;
      const i = p.info;
      if (i) {
        u.ctx = i.last_token_usage?.total_tokens ?? u.ctx;
        u.ctxMax = i.model_context_window ?? u.ctxMax;
        u.out = i.total_token_usage?.output_tokens ?? u.out;
      }
      const r = p.rate_limits;
      if (r) {
        u.limits = [r.primary, r.secondary].filter((w) => w && typeof w.used_percent === "number")
          .map((w) => ({ short: windowName(w.window_minutes), pct: w.used_percent, resets: w.resets_at ? w.resets_at * 1000 : null }));
      }
    }
  }
  if (kind === "claude") u.out = [...u.outBy.values()].reduce((a, b) => a + b, 0);
}

// Claude plan usage saved by statusline.cjs: { at, rate_limits: { five_hour, seven_day, … } } | null
export async function readPlan() {
  try { return JSON.parse(await readFile(`${appHome()}/data/my-status/usage.json`, "utf8")); } catch { return null; }
}

export function planWindows(plan) {
  return Object.entries(plan?.rate_limits ?? {})
    .filter(([, w]) => w && typeof w.used_percentage === "number")
    .map(([key, w]) => {
      const r = w.resets_at;
      const resets = typeof r === "number" ? (r < 1e12 ? r * 1000 : r) : typeof r === "string" ? Date.parse(r) || null : null;
      const short = key === "five_hour" ? "5h" : key === "seven_day" ? "wk" : key.replace(/^seven_day_/, "wk ").replace(/_/g, " ");
      return { key, short, pct: w.used_percentage, resets };
    })
    .sort((a, b) => (a.key === "five_hour" ? -1 : b.key === "five_hour" ? 1 : a.key.localeCompare(b.key)));
}

// Whether a chat's model draws from the Claude subscription.
export function usesClaudePlan(kind, model) {
  return kind === "claude" || (kind === "pi" && /^(anthropic|claude-bridge)\//.test(model ?? ""));
}

export function tokens(n) {
  if (n >= 1e6) return `${n % 1e6 === 0 || n >= 1e7 ? Math.round(n / 1e6) : (n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// "2h 10m", "4d 3h", "12m" until `ms`; null if unknown.
export function until(ms) {
  if (!ms) return null;
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
