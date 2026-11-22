const MAX_HISTORY = 200;
const MAX_DRAFTS = 40;
const MAX_DRAFT_CHARS = 16000;

export function isCaretOnFirstLine(text, caret) {
  const s = String(text ?? "");
  const pos = Math.max(0, Math.min(s.length, Number.isFinite(caret) ? caret : s.length));
  return s.lastIndexOf("\n", pos - 1) === -1;
}

export function isCaretOnLastLine(text, caret) {
  const s = String(text ?? "");
  const pos = Math.max(0, Math.min(s.length, Number.isFinite(caret) ? caret : s.length));
  return s.indexOf("\n", pos) === -1;
}

export class PromptHistory {
  constructor() {
    this.entries = [];
    this.cursor = -1;
    this.draft = "";
  }

  get browsing() {
    return this.cursor !== -1;
  }

  seedFromItems(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const seeded = [];
    for (const item of items) {
      if (item?.kind !== "user") continue;
      const text = String(item.text ?? "").trim();
      if (!text) continue;
      if (seeded[seeded.length - 1] !== text) seeded.push(text);
    }
    if (!seeded.length) return;
    // Preserve any locally recorded prompts not yet flushed to the transcript.
    const merged = seeded.slice();
    for (const entry of this.entries) {
      if (merged[merged.length - 1] !== entry && !seeded.includes(entry)) {
        merged.push(entry);
      }
    }
    this.entries = merged.slice(-MAX_HISTORY);
    if (this.cursor >= this.entries.length) this.cursor = this.entries.length - 1;
  }

  record(text) {
    const clean = String(text ?? "").trim();
    this.cursor = -1;
    this.draft = "";
    if (!clean) return;
    if (this.entries[this.entries.length - 1] !== clean) {
      this.entries.push(clean);
      if (this.entries.length > MAX_HISTORY) this.entries.shift();
    }
  }

  resetNavigation() {
    this.cursor = -1;
    this.draft = "";
  }

  canStepUp(text, caret) {
    if (!this.entries.length) return false;
    return isCaretOnFirstLine(text, caret);
  }

  canStepDown(text, caret) {
    if (this.cursor === -1) return false;
    return isCaretOnLastLine(text, caret);
  }

  stepUp(currentText, caret) {
    if (!this.entries.length) return { handled: false };
    const text = String(currentText ?? "");
    if (!isCaretOnFirstLine(text, caret)) return { handled: false };
    if (this.cursor === -1) {
      this.draft = text;
      this.cursor = this.entries.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    }
    const value = this.entries[this.cursor] ?? "";
    return { handled: true, value, caret: value.length };
  }

  stepDown(currentText, caret) {
    if (this.cursor === -1) return { handled: false };
    const text = String(currentText ?? "");
    if (!isCaretOnLastLine(text, caret)) return { handled: false };
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      const value = this.entries[this.cursor] ?? "";
      return { handled: true, value, caret: value.length };
    }
    const restored = this.draft;
    this.cursor = -1;
    this.draft = "";
    return { handled: true, value: restored, caret: restored.length };
  }
}

export class DraftStore {
  constructor(storage = null, storageKey = "any-chat.drafts.v1") {
    this.storage = storage ?? (typeof globalThis.localStorage !== "undefined" ? globalThis.localStorage : null);
    this.storageKey = storageKey;
    this.map = new Map();
    this._load();
  }

  _load() {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.length > 0) this.map.set(k, v);
      }
    } catch {}
  }

  _save() {
    if (!this.storage) return;
    try {
      const entries = Array.from(this.map.entries()).slice(-MAX_DRAFTS);
      const obj = Object.fromEntries(entries);
      this.storage.setItem(this.storageKey, JSON.stringify(obj));
    } catch {}
  }

  get(key) {
    if (!key) return "";
    return this.map.get(key) ?? "";
  }

  set(key, text) {
    if (!key) return;
    const value = String(text ?? "");
    if (!value) {
      if (this.map.delete(key)) this._save();
      return;
    }
    const bounded = value.length > MAX_DRAFT_CHARS ? value.slice(0, MAX_DRAFT_CHARS) : value;
    if (this.map.get(key) === bounded) return;
    this.map.delete(key);
    this.map.set(key, bounded);
    while (this.map.size > MAX_DRAFTS) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this._save();
  }
}
