// Interactive question cards in chat for both Claude Code (AskUserQuestion) and Pi
// (ask_user_choice, ask_user_question, plan_mode_question). Tool arguments supply the
// structured prompt/options; live screen reads (`hc read`) track cursor, active tab, and
// multi-select ticks; clicks send stepped `hc keys` so TUI cursors settle before Enter/Space.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { hc, shared } from "herdr";
import {
  flat,
  isQuestionTool as _isQuestionTool,
  normalizeAsk,
  pendingAsk,
  parseScreen,
  planOptionSteps,
  planSubmitSteps,
  planTabSteps,
  planCustomAnswerSteps,
  parseLoggedAnswers,
  detectFallbackKeys as _detectFallbackKeys,
} from "./question-core.js";

export const isQuestionTool = (name) => _isQuestionTool(name);
export const detectFallbackKeys = (screen, kind) => _detectFallbackKeys(screen, kind);

const RECOMMENDED = / \(Recommended\)$/;
const AGENT_NAMES = { claude: "Claude", pi: "Pi", codex: "Codex", opencode: "OpenCode" };

function parts(text) {
  const paras = String(text ?? "").trim().split(/\n\s*\n/);
  return { context: paras.slice(0, -1).join("\n\n"), question: paras[paras.length - 1] ?? "" };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runSteps(address, steps) {
  for (const step of steps) {
    if (step.delayMs) await pause(step.delayMs);
    if (step.keys?.length) {
      // Send arrow steps individually with a tiny gap when moving multiple rows so TUI never drops keys.
      if (step.keys.length > 1 && step.keys.every((k) => k === "up" || k === "down" || k === "left" || k === "right")) {
        for (let i = 0; i < step.keys.length; i++) {
          if (i > 0) await pause(25);
          await hc(["keys", address, step.keys[i]]);
        }
      } else {
        await hc(["keys", address, ...step.keys]);
      }
    } else if (typeof step.sendText === "string") {
      await hc(["send", "--force", address, step.sendText]);
    }
  }
}

export const rejected = (item) =>
  Boolean(item.error) && /^(Error: )?PreToolUse:\S+ hook error/.test(item.result ?? "");

export function pending(items) {
  return pendingAsk(items);
}

export function where(screen, itemOrQuestions) {
  const ask = Array.isArray(itemOrQuestions)
    ? { protocol: "claude", questions: itemOrQuestions }
    : normalizeAsk(itemOrQuestions);
  return parseScreen(screen, ask);
}

function dispatchSteps(view, steps) {
  return (_e, cx) => {
    if (!steps?.length) return;
    const address = view.address;
    view.screen = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await runSteps(address, steps);
      } catch {}
      await pause(220);
      await view.tick(cx);
      await pause(450);
      await view.tick(cx);
    });
  };
}

export function typeAnswer(view, text, cx) {
  const item = pending(view.items);
  const ask = normalizeAsk(item);
  if (!ask) return false;
  const w = parseScreen(view.screen, ask) ?? (view.lastAskId === item.id ? view.lastAsk : null);
  if (!w || w.at >= ask.questions.length) return false;
  const steps = planCustomAnswerSteps(ask, w, text);
  if (!steps.length) return false;
  const address = view.address;
  view.screen = null;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await runSteps(address, steps);
    } catch {}
    await pause(260);
    await view.tick(cx);
  });
  return true;
}

export function card(view, t, px) {
  const item = pending(view.items);
  const ask = normalizeAsk(item);
  if (!ask?.questions?.length) return null;

  const w = parseScreen(view.screen, ask);
  if (w) {
    view.lastAsk = w;
    view.lastAskId = item.id;
  }
  const shown = w ?? (view.lastAskId === item.id && view.screen === null ? view.lastAsk : null);
  if (!shown) return null;

  const wait = !w;
  const questions = ask.questions;
  const many = questions.length > 1;
  const folded = view.askFolded === item.id;
  const fold = (_e, cx) => {
    view.askFolded = folded ? null : item.id;
    cx.notify();
  };
  const speaker = AGENT_NAMES[view.kind] ?? "Agent";
  const title = many ? `${speaker} has questions` : `${speaker} is asking`;
  const current = questions[Math.min(shown.at, questions.length - 1)];

  const tabs = ask.protocol === "claude"
    ? [...questions.map((q, i) => [q.header || `Q${i + 1}`, i]), ["Submit", questions.length]]
    : questions.map((q, i) => [q.header || `Q${i + 1}`, i]);

  const head = h_flex().gap(8).items_center()
    .child(div().size(8).flex_none().rounded(4).bg(t.blocked)
      .when(shared("p5.motion") !== false, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 })))
    .child(h_flex().id("ask-fold").flex_1().min_w(0).gap(6).items_center().cursor_pointer()
      .tooltip(folded ? "Show the question" : "Fold the question")
      .on_click(fold)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child(title))
      .when(folded, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted)
        .child(flat(parts(current?.question).question))))
      .when(!folded, (el) => el.child(div().flex_1()))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none().text_color(t.dim)))
    .when(many && !folded, (el) => el.child(h_flex().flex_none().gap(4)
      .children(tabs.map(([label, i]) =>
        div().id(`ask-tab-${i}`).px(8).py(2).rounded(6).text_size(px(11)).cursor_pointer()
          .when(i === shown.at, (el) => el.bg(t.selected).text_color(t.foreground))
          .when(i !== shown.at, (el) => el.text_color(t.dim).hover((s) => s.text_color(t.foreground)))
          .on_click(dispatchSteps(view, planTabSteps(ask, shown, i)))
          .child(shown.done.has(label) ? `✓ ${label}` : label)))));

  const foot = (hint) => h_flex().gap(8).items_center()
    .child(div().flex_1().min_w(0).text_size(px(11.5)).text_color(t.dim).child(hint))
    .child(view.button(t, "ask-esc", "Dismiss", dispatchSteps(view, [{ keys: ["esc"] }])))
    .child(view.button(t, "ask-terminal", "Open terminal", () => view.toTerminal(view.address)));

  const box = v_flex().gap(10).p(12).rounded(10).bg(t.surface).border(1).border_color(t.blocked)
    .when(wait, (el) => el.opacity(0.6))
    .child(head);

  if (folded) return box.p(8).gap(0);

  if (shown.at === questions.length) {
    return box
      .child(div().text_size(px(14)).font_semibold().text_color(t.foreground).child("Send these answers?"))
      .child(v_flex().gap(6).children(shown.review.map((r, i) => v_flex().id(`ask-review-${i}`).gap(2)
        .child(div().text_size(px(12)).text_color(t.muted).child(r.q))
        .child(div().text_color(t.foreground).font_medium().child(`→ ${r.a || "(no answer)"}`)))))
      .child(h_flex().gap(6)
        .child(view.button(t, "ask-submit", "Submit answers", dispatchSteps(view, planSubmitSteps(ask, shown)), true))
        .child(view.button(t, "ask-back", "Back", dispatchSteps(view, [{ keys: ["left"] }]))))
      .child(foot(""));
  }

  const q = questions[shown.at];
  const multi = Boolean(q.multiSelect);
  const options = (q.options ?? []).map((o, i) => {
    const pos = i + 1;
    const best = RECOMMENDED.test(o.label);
    const on = shown.ticked.has(pos);
    const active = shown.cursor === pos;
    return h_flex().id(`ask-opt-${shown.at}-${i}`).w_full().gap(10).items_start().px(10).py(8).rounded(8)
      .bg(t.background).border(1).border_color(on || active ? t.accent : t.border).cursor_pointer()
      .hover((s) => s.border_color(t.accent))
      .on_click(dispatchSteps(view, planOptionSteps(ask, shown, pos)))
      .when(multi, (el) => el.child(div().mt(2).size(14).flex_none().rounded(3).border(1)
        .border_color(on ? t.accent : t.dim).bg(on ? t.accent : t.background)
        .flex().items_center().justify_center().text_size(10).text_color(t.solid_foreground).child(on ? "✓" : "")))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(8).items_center()
          .child(div().font_semibold().text_color(t.foreground).child(o.label.replace(RECOMMENDED, "")))
          .when(best, (el) => el.child(div().flex_none().px(6).rounded(4).text_size(px(10.5))
            .bg(t.accent).text_color(t.solid_foreground).child("Recommended"))))
        .when(Boolean(o.description), (el) => el.child(div().text_size(px(12)).text_color(t.muted)
          .child(TextView.markdown(`ask-desc-${shown.at}-${i}`, o.description)))));
  });

  const { context, question } = parts(q.question);
  const hint = q.allowCustom
    ? "Click an option, or type your own answer below and press Enter."
    : "Click an option to answer.";

  return box
    .when(Boolean(context), (el) => el.child(div().text_color(t.muted)
      .child(TextView.markdown(`ask-context-${shown.at}`, context).selectable(true))))
    .child(div().text_size(px(14)).font_semibold().text_color(t.foreground)
      .child(TextView.markdown(`ask-question-${shown.at}`, question).selectable(true)))
    .when(multi, (el) => el.child(div().text_size(px(11.5)).text_color(t.dim)
      .child(ask.protocol === "claude" ? "Pick any, then Next." : "Click options to toggle, then Confirm.")))
    .child(v_flex().gap(6).children(options))
    .when(multi, (el) => el.child(h_flex().child(view.button(t, "ask-next", many ? "Next" : "Confirm",
      dispatchSteps(view, planSubmitSteps(ask, shown)), true))))
    .child(foot(hint));
}

export function asked(t, px, item) {
  const ask = normalizeAsk(item);
  const questions = ask?.questions ?? [];
  if (item.result === undefined) {
    return div().w_full().pl(16).text_size(px(12)).text_color(t.dim)
      .child(`Asking: ${questions.map((q) => q.header || flat(q.question).slice(0, 60)).join(", ")} ↓`);
  }
  const pairs = parseLoggedAnswers(item);
  return v_flex().w_full().pl(16).gap(6).children(pairs.map((p, i) =>
    v_flex().id(`asked-${item.id}-${i}`).gap(3).pl(10).border_l(2).border_color(item.error ? t.dim : t.accent)
      .child(div().text_size(px(12)).text_color(t.muted).child(flat(parts(p.question).question)))
      .child(div().text_size(px(13)).text_color(t.foreground).font_medium()
        .child(p.answer ? `→ ${p.answer}` : item.error ? "(rejected)" : "(no answer)"))));
}
