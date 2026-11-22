// Pure parsing and key-sequencing logic for interactive agent questions:
// - Claude Code: AskUserQuestion
// - Pi: ask_user_choice, ask_user_question, plan_mode_question

export const QUESTION_TOOLS = new Set([
  "AskUserQuestion",
  "ask_user_choice",
  "ask_user_question",
  "plan_mode_question",
]);

export const flat = (s) =>
  String(s ?? "")
    .replace(/[│┃╭╮╰╯─━]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const stripBox = (line) =>
  String(line ?? "")
    .replace(/^\s*[│┃]\s?/, "")
    .replace(/\s?[│┃]\s*$/, "");

export function isQuestionTool(name) {
  return QUESTION_TOOLS.has(String(name ?? ""));
}

export function pendingAsk(items) {
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "tool" && isQuestionTool(item.name)) {
      return item.result === undefined ? item : null;
    }
  }
  return null;
}

export function normalizeAsk(item) {
  if (!item || !isQuestionTool(item.name)) return null;
  const input = item.input ?? {};
  if (item.name === "ask_user_choice") {
    const opts = Array.isArray(input.options) ? input.options : [];
    return {
      id: item.id,
      toolName: item.name,
      protocol: "pi-choice",
      questions: [
        {
          question: String(input.question ?? ""),
          header: "",
          multiSelect: false,
          allowCustom: input.allowCustomResponse !== false,
          options: opts.map((o) => ({
            label: String(o?.label ?? ""),
            description: String(o?.description ?? ""),
            value: o?.value,
          })),
        },
      ],
    };
  }
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (!rawQuestions.length) return null;
  const protocol = item.name === "AskUserQuestion" ? "claude" : "pi-question";
  return {
    id: item.id,
    toolName: item.name,
    protocol,
    questions: rawQuestions.map((q) => ({
      question: String(q?.question ?? ""),
      header: String(q?.header ?? ""),
      multiSelect: Boolean(q?.multiSelect),
      allowCustom: true,
      options: (Array.isArray(q?.options) ? q.options : []).map((o) => ({
        label: String(o?.label ?? ""),
        description: String(o?.description ?? ""),
        preview: o?.preview ? String(o.preview) : "",
      })),
    })),
  };
}

function matchQuestionIndex(screen, text, questions) {
  for (let i = 0; i < questions.length; i++) {
    const qFlat = flat(questions[i].question);
    if (!qFlat) continue;
    const prefix = qFlat.slice(0, Math.min(48, qFlat.length));
    if (prefix.length >= 8 && text.includes(prefix)) return i;
  }
  // Fallback: match when at least one option label appears on screen
  for (let i = 0; i < questions.length; i++) {
    const opts = questions[i].options ?? [];
    if (opts.some((o) => o.label && text.includes(flat(o.label)))) return i;
  }
  return -1;
}

function parseClaudeScreen(screen, ask) {
  const questions = ask.questions;
  const lines = screen.split("\n").map(stripBox);
  const text = flat(screen);
  let at = /Review your answers/.test(screen)
    ? questions.length
    : matchQuestionIndex(screen, text, questions);
  if (at < 0) return null;

  const n = questions[at]?.options?.length ?? 0;
  let cursor = 1;
  const ticked = new Set();
  for (const line of lines) {
    const m = /^\s*❯\s*(\d+)\./.exec(line);
    if (m) cursor = Number(m[1]);
    else if (/^\s*❯\s*Submit\b/.test(line)) cursor = n + 2;
    const box = /^\s*(?:❯\s*)?(\d+)\.\s*\[(.)\]/.exec(line);
    if (box && box[2] !== " ") ticked.add(Number(box[1]));
  }
  const done = new Set(
    questions
      .filter((q) => q.header && (screen.includes(`☒ ${q.header}`) || screen.includes(`✓ ${q.header}`)))
      .map((q) => q.header),
  );
  const review = [];
  if (at === questions.length) {
    for (const line of lines) {
      if (/^\s*●/.test(line)) review.push({ q: flat(line.replace(/^\s*●/, "")), a: "" });
      else if (/^\s*→/.test(line) && review.length) review[review.length - 1].a = flat(line.replace(/^\s*→/, ""));
    }
  }
  return { at, cursor, ticked, done, review, customOpen: false };
}

function parsePiScreen(screen, ask) {
  const questions = ask.questions;
  const lines = screen.split("\n").map(stripBox);
  const text = flat(screen);

  let at = -1;
  // QuestionnaireView renders a tab counter `[1/2]`
  const tabCounter = /\[(\d+)\/(\d+)\]/.exec(text);
  if (tabCounter && Number(tabCounter[2]) === questions.length) {
    const idx = Number(tabCounter[1]) - 1;
    if (idx >= 0 && idx < questions.length) at = idx;
  }
  if (at < 0) at = matchQuestionIndex(screen, text, questions);
  if (at < 0) return null;

  const q = questions[at];
  const opts = q?.options ?? [];
  let cursor = 1;
  const ticked = new Set();
  const customLabels = ["type your answer", "type something."];
  let matchedCursor = false;

  for (const line of lines) {
    const marker = /^\s*([→❯])\s*(.*)$/.exec(line);
    const body = (marker ? marker[2] : line).trim();
    const boxMatch = /^\[(x|X|✓| )\]\s*(.*)$/.exec(body);
    const labelText = (boxMatch ? boxMatch[2] : body).trim().toLowerCase();
    const isTicked = Boolean(boxMatch && boxMatch[1] !== " ");

    let rowPos = -1;
    for (let i = 0; i < opts.length; i++) {
      const optLabel = flat(opts[i].label).toLowerCase();
      if (!optLabel) continue;
      if (labelText === optLabel || labelText.startsWith(`${optLabel} `) || labelText.startsWith(`${optLabel}—`)) {
        rowPos = i + 1;
        break;
      }
    }
    if (rowPos < 0 && q?.allowCustom && customLabels.some((cl) => labelText.startsWith(cl))) {
      rowPos = opts.length + 1;
    }

    if (rowPos > 0) {
      if (isTicked) ticked.add(rowPos);
      if (marker && !matchedCursor) {
        cursor = rowPos;
        matchedCursor = true;
      }
    }
  }

  const done = new Set(
    questions
      .filter((item) => item.header && screen.includes(`✓ ${item.header}`))
      .map((item) => item.header),
  );
  const customOpen =
    !matchedCursor && /enter\s+submit|esc\s+back|type your answer/i.test(text) && !/↑↓\s*(?:navigate|move)/i.test(text);

  return { at, cursor, ticked, done, review: [], customOpen };
}

export function parseScreen(screen, ask) {
  if (!screen || !ask?.questions?.length) return null;
  if (ask.protocol === "claude") return parseClaudeScreen(screen, ask);
  return parsePiScreen(screen, ask);
}

function arrowKeys(cursor, to) {
  const d = to - cursor;
  return Array(Math.abs(d)).fill(d > 0 ? "down" : "up");
}

export function planOptionSteps(ask, state, pos) {
  if (!ask || !state) return [];
  const q = ask.questions[state.at];
  const arrows = arrowKeys(state.cursor, pos);
  const actionKey = ask.protocol === "pi-question" && q?.multiSelect ? "space" : "enter";
  if (!arrows.length) return [{ keys: [actionKey] }];
  return [{ keys: arrows }, { keys: [actionKey], delayMs: 50 }];
}

export function planSubmitSteps(ask, state) {
  if (!ask || !state) return [];
  if (ask.protocol === "claude") {
    if (state.at === ask.questions.length) {
      const arrows = arrowKeys(state.cursor, 1);
      return arrows.length ? [{ keys: arrows }, { keys: ["enter"], delayMs: 50 }] : [{ keys: ["enter"] }];
    }
    const q = ask.questions[state.at];
    const target = (q?.options?.length ?? 0) + 2;
    const arrows = arrowKeys(state.cursor, target);
    return arrows.length ? [{ keys: arrows }, { keys: ["enter"], delayMs: 50 }] : [{ keys: ["enter"] }];
  }
  // Pi QuestionnaireView submits the current question directly on Enter.
  return [{ keys: ["enter"] }];
}

export function planTabSteps(ask, state, targetAt) {
  if (!ask || !state || targetAt === state.at) return [];
  const diff = targetAt - state.at;
  if (ask.protocol === "claude") {
    return [{ keys: Array(Math.abs(diff)).fill(diff > 0 ? "right" : "left") }];
  }
  const key = diff > 0 ? "tab" : "shift+tab";
  return Array.from({ length: Math.abs(diff) }, (_, idx) =>
    idx === 0 ? { keys: [key] } : { keys: [key], delayMs: 40 },
  );
}

export function planCustomAnswerSteps(ask, state, text) {
  if (!ask || !state) return [];
  const q = ask.questions[state.at];
  if (!q || !q.allowCustom) return [];
  const customPos = (q.options?.length ?? 0) + 1;
  const arrows = arrowKeys(state.cursor, customPos);

  if (ask.protocol === "claude") {
    const steps = [];
    if (arrows.length) steps.push({ keys: arrows });
    steps.push({ sendText: text, delayMs: arrows.length ? 50 : 0 });
    return steps;
  }

  // Pi NativeChoiceList & QuestionnaireView require Enter on the custom row to open the text editor.
  if (state.customOpen) return [{ sendText: text }];
  const steps = [];
  if (arrows.length) steps.push({ keys: arrows });
  steps.push({ keys: ["enter"], delayMs: arrows.length ? 50 : 0 });
  steps.push({ sendText: text, delayMs: 100 });
  return steps;
}

export function parseLoggedAnswers(item) {
  const ask = normalizeAsk(item);
  if (!ask) return [];
  const result = String(item.result ?? "");
  if (ask.protocol === "claude") {
    return ask.questions.map((q) => {
      const key = `"${q.question}"="`;
      const at = result.indexOf(key);
      if (at < 0) return { question: q.question, answer: null };
      const m = /^([\s\S]*?)"(?=, "|\. |$)/.exec(result.slice(at + key.length));
      return { question: q.question, answer: (m?.[1] ?? "").replace(/<hc\b[^>]*>|<\/hc>/g, "") };
    });
  }
  if (ask.protocol === "pi-choice") {
    const q = ask.questions[0];
    let answer = null;
    const sel = /^User selected:\s*\d+\.\s*(.+?)(?:\s*\(value:.*\))?$/m.exec(result);
    const resp = /^User responded:\s*([\s\S]+)$/m.exec(result);
    if (sel) answer = sel[1].trim();
    else if (resp) answer = resp[1].trim();
    else if (/cancelled/i.test(result)) answer = "(cancelled)";
    else if (result.trim()) answer = result.trim();
    return [{ question: q.question, answer }];
  }
  // Pi ask_user_question / plan_mode_question
  const lines = result.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return ask.questions.map((q, i) => {
    const prefix = `${i + 1}. `;
    const hit = lines.find((l) => l.startsWith(prefix));
    if (hit) {
      const dash = hit.lastIndexOf(" — ");
      if (dash >= 0) return { question: q.question, answer: hit.slice(dash + 3).trim() };
    }
    return { question: q.question, answer: /cancelled/i.test(result) ? "(cancelled)" : null };
  });
}

export function detectFallbackKeys(screen, kind) {
  const text = String(screen ?? "");
  const numbered = /^\s*[│┃]?\s*(?:❯\s*)?1\.\s/m.test(text);
  const piArrowMenu = /^\s*[│┃]?\s*[→❯]\s+[^0-9]/m.test(text);
  if (kind === "claude" && (numbered || !text.trim())) {
    return [
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["Enter", "enter"],
      ["Esc", "esc"],
    ];
  }
  if (numbered && !piArrowMenu && kind !== "pi") {
    return [
      ["1", "1"],
      ["2", "2"],
      ["3", "3"],
      ["Enter", "enter"],
      ["Esc", "esc"],
    ];
  }
  return [
    ["↑", "up"],
    ["↓", "down"],
    ["Enter", "enter"],
    ["Esc", "esc"],
  ];
}
