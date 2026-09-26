"use strict";

/**
 * jev-guard / lib/diff_guard.js — Surgical Diff Guard.
 *
 * Перехватывает `tool_call` для edit/ctx_patch/multi-edit. Извлекает патч/текст
 * замены и задаёт Jev два параллельных вопроса: `modifies_secrets` и
 * `is_surgical`. Если попытка изменить секреты/токены/учётные данные
 * (probability > 0.80) — операция БЛОКИРУЕТСЯ.
 *
 * Fail-Soft: если Jev молчит (null) или вероятность не превышает порог —
 * операцию не блокируем. Агент не должен вставать из-за падения API.
 */

const SECRETS_THRESHOLD = 0.80;
const TARGET_TOOLS = new Set(["edit", "ctx_patch", "multi-edit"]);

// Собирает читаемый патч/текст замены из аргументов инструмента.
function extractDiff(input) {
  if (input == null) return null;
  const parts = [];
  const push = (s) => { if (typeof s === "string" && s.trim()) parts.push(s.trim()); };

  // ctx_patch: find/replace, old_text/new_text
  push(input.find);
  push(input.replace);
  push(input.old_text);
  push(input.new_text);

  // edit: { path, edits: [{oldText, newText}] }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!e) continue;
      push(e.oldText);
      push(e.newText);
    }
  }
  // multi-edit: { path, multi: [{oldText, newText}] }
  if (Array.isArray(input.multi)) {
    for (const e of input.multi) {
      if (!e) continue;
      push(e.oldText);
      push(e.newText);
    }
  }

  if (parts.length === 0) {
    try {
      const j = JSON.stringify(input);
      if (j) parts.push(j);
    } catch { /* noop */ }
  }
  return parts.length ? parts.join("\n---\n") : null;
}

function getNoulProbability(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.noul === "number") return obj.noul;
  if (typeof obj.probability === "number") return obj.probability;
  return null;
}

/**
 * Создаёт обработчик хука `tool_call`.
 * @param {object} deps { ask: async ({state, questions}) => answers|null }
 */
function createDiffGuard({ ask }) {
  const stats = { checked: 0, blocked: 0 };

  async function toolCallHandler(event) {
    const name = event && event.toolName;
    if (!TARGET_TOOLS.has(name)) return undefined;

    const diff = extractDiff(event.input);
    if (!diff) return undefined;

    stats.checked += 1;

    let answers = null;
    try {
      answers = await ask({
        state: diff,
        questions: require("./client").diffQuestions(),
      });
    } catch (err) {
      // Fail-soft: падение API — не блокируем.
      return undefined;
    }

    const p = answers && answers.modifies_secrets
      ? getNoulProbability(answers.modifies_secrets)
      : null;
    if (typeof p === "number" && p > SECRETS_THRESHOLD) {
      stats.blocked += 1;
      return { block: true, reason: "BLOCKED by jev-guard: attempt to modify secrets or credentials." };
    }
    return undefined;
  }

  return { toolCallHandler, stats, SECRETS_THRESHOLD };
}

module.exports = {
  createDiffGuard,
  extractDiff,
  SECRETS_THRESHOLD,
  TARGET_TOOLS,
};
