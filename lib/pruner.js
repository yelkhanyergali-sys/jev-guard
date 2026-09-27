"use strict";

/**
 * jev-guard / lib/pruner.js — In-Flight Terminal Pruning.
 *
 * Перехватывает `tool_result` только для шелл-инструментов (bash/shell/
 * powershell и ctx_shell/ctx_execute). Search-инструменты (grep/find/ls/ctx_*)
 * НЕ трогаем: их успешный вывод — это сами данные, сворачивать нечего.
 *
 * Длинный успешный вывод (> maxLength) проверяется Jev-вопросом
 * `has_actionable_error`. Если ошибок нет (вероятность < collapseThreshold) —
 * вывод НЕ стирается, а сжимается до head/tail-превью: первые и последние
 * previewLines строк, середина заменяется маркером `[... K lines omitted ...]`.
 * Агент продолжает видеть начало, финальный статус-лайн и любые строки
 * ERROR/WARN/FAIL внутри превью.
 *
 * Защита Prompt Cache: подмена происходит на САМОМ СВЕЖЕМ хвосте хода, в хуке
 * `tool_result`, т.е. ДО того, как результат попадает в массив сообщений
 * сессии. Предшествующий префикс остаётся байт-в-байт стабильным.
 *
 * Ошибки (`event.isError === true`) никогда не трогаем — они нужны агенту
 * полностью. При падении API (ask → null) вывод тоже не трогаем (fail-soft).
 */

const { loadConfig } = require("./config");
const client = require("./client");

const DEFAULT_MAX_LENGTH = 4000;
const DEFAULT_COLLAPSE_THRESHOLD = 0.2;
const DEFAULT_PREVIEW_LINES = 10;

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

// Строчный маркер «сколько съэкономлено» — виден агенту как факт, не как магия.
function compressHeadTail(text, previewLines) {
  const lines = text.split("\n");
  const n = Math.max(2, previewLines);
  if (lines.length <= n * 2) return null; // сжимать нечего
  const head = lines.slice(0, n);
  const tail = lines.slice(-n);
  const omitted = lines.length - n * 2;
  return [
    ...head,
    `[... ${omitted} lines omitted by jev-guard: clean output, exit code 0 ...]`,
    ...tail,
  ].join("\n");
}

/**
 * Создаёт обработчик хука `tool_result`.
 * @param {object} deps { ask: async ({state, questions}) => answers|null,
 *                        config?: объект из loadConfig() }
 */
function createPruner({ ask, config }) {
  const cfg = { ...loadConfig(), ...(config || {}) };
  const targetTools = new Set(cfg.prunerTools);
  const maxLength = cfg.prunerMaxLength;
  const threshold = cfg.collapseThreshold;
  const previewLines = cfg.prunerPreviewLines;
  const stats = { checked: 0, collapsed: 0, savedChars: 0 };

  async function toolResultHandler(event) {
    const name = event && event.toolName;
    if (!targetTools.has(name)) return undefined;
    // Ошибки нужны агенту полностью — никогда не сворачиваем.
    if (event.isError === true) return undefined;

    const text = extractText(event.content);
    if (text == null || text.length <= maxLength) return undefined;

    stats.checked += 1;

    let answers = null;
    try {
      answers = await ask({
        state: text,
        questions: { has_actionable_error: client.hasActionableErrorQuestion() },
      });
    } catch {
      // Fail-soft: падение API не должно ломать агента.
      return undefined;
    }

    // Читаем по типу вопроса (noul -> поле `noul`), не .probability.
    const p = answers ? client.answerValue(answers.has_actionable_error) : null;
    if (typeof p === "number" && p < threshold) {
      const compressed = compressHeadTail(text, previewLines);
      if (compressed == null) return undefined;
      stats.collapsed += 1;
      stats.savedChars += text.length - compressed.length;
      return { content: [{ type: "text", text: compressed }] };
    }
    return undefined; // есть ошибка или API молчит — оставляем вывод как есть
  }

  return {
    toolResultHandler,
    stats,
    targetTools,
    maxLength,
    threshold,
    previewLines,
  };
}

module.exports = {
  createPruner,
  extractText,
  lineCount,
  compressHeadTail,
  DEFAULT_MAX_LENGTH,
  DEFAULT_COLLAPSE_THRESHOLD,
  DEFAULT_PREVIEW_LINES,
};
