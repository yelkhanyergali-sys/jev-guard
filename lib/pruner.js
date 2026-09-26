"use strict";

/**
 * jev-guard / lib/pruner.js — In-Flight Terminal Pruning.
 *
 * Перехватывает `tool_result` для bash/ctx_shell. Успешный и достаточно
 * длинный вывод (>800 символов) проверяется Jev-вопросом `has_actionable_error`.
 * Если ошибок нет (вероятность < 0.20) — вывод сворачивается в одну компактную
 * строку.
 *
 * Защита Prompt Cache: подмена происходит на САМОМ СВЕЖЕМ хвосте хода, в хуке
 * `tool_result`, т.е. ДО того, как результат попадает в массив сообщений
 * сессии. Предшествующий префикс остаётся байт-в-байт стабильным — кэш-хит
 * сохраняется на 100%.
 *
 * Ошибки (`event.isError === true`) никогда не трогаем — они нужны агенту
 * полностью. При падении API (ask → null) вывод тоже не трогаем (fail-soft).
 */

const MAX_LENGTH = 800;
const COLLAPSE_THRESHOLD = 0.20; // has_actionable_error < 0.20 → успех → сворачиваем
const TARGET_TOOLS = new Set(["bash", "ctx_shell"]);

// Извлекает текстовое представление content (string | массив parts | объект).
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out = [];
    for (const p of content) {
      if (p == null) continue;
      if (typeof p === "string") out.push(p);
      else if (typeof p === "object" && typeof p.text === "string") out.push(p.text);
    }
    return out.join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return null;
}

function lineCount(text) {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function getNoulProbability(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.noul === "number") return obj.noul;
  if (typeof obj.probability === "number") return obj.probability;
  return null;
}

function collapseLine(lineCount) {
  return `[Output collapsed by jev-guard: ${lineCount} lines of successful output, exit code 0]`;
}

/**
 * Создаёт обработчик хука `tool_result`.
 * @param {object} deps { ask: async ({state, questions}) => answers|null }
 */
function createPruner({ ask }) {
  const stats = { checked: 0, collapsed: 0 };

  async function toolResultHandler(event) {
    const name = event && event.toolName;
    if (!TARGET_TOOLS.has(name)) return undefined;
    // Ошибки нужны агенту полностью — никогда не сворачиваем.
    if (event.isError === true) return undefined;

    const text = extractText(event.content);
    if (text == null || text.length <= MAX_LENGTH) return undefined;

    stats.checked += 1;

    let answers = null;
    try {
      answers = await ask({
        state: text,
        questions: { has_actionable_error: require("./client").hasActionableErrorQuestion() },
      });
    } catch (err) {
      // Fail-soft: падение API не должно ломать агента.
      return undefined;
    }

    const p = answers && answers.has_actionable_error
      ? getNoulProbability(answers.has_actionable_error)
      : null;
    if (typeof p === "number" && p < COLLAPSE_THRESHOLD) {
      stats.collapsed += 1;
      return { content: collapseLine(lineCount(text)) };
    }
    return undefined; // есть ошибка или API молчит — оставляем вывод как есть
  }

  return { toolResultHandler, stats, MAX_LENGTH, COLLAPSE_THRESHOLD };
}

module.exports = {
  createPruner,
  extractText,
  lineCount,
  collapseLine,
  MAX_LENGTH,
  COLLAPSE_THRESHOLD,
  TARGET_TOOLS,
};
