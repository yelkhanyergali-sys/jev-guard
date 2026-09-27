"use strict";

/**
 * jev-guard / lib/diff_guard.js — Surgical Diff Guard.
 *
 * Перехватывает `tool_call` для пишущих инструментов (edit/multi-edit/ctx_patch/
 * ctx_edit/write). Извлекает патч/текст замены и защищает от правок секретов
 * ДВУМЯ слоями:
 *
 *   1) Детерминированный regex-слой (дёшево, без сети): известные сигнатуры
 *      секретов (sk-..., AKIA..., -----BEGIN PRIVATE KEY-----, присвоения
 *      *_KEY= в .env и т.д.) → мгновенный блок. Не тратит вызов Jev.
 *
 *   2) Jev-слой: вопрос `modifies_secrets`. Если probability > secretsThreshold
 *      → блок. Второй вопрос `is_surgical` — advisory: при низкой вероятности
 *      (drive-by рефакторинг) возвращает предупреждение (warn), НЕ блокирует
 *      поток (в ядре блокирует только поле `block`).
 *
 * Fail-Soft: если Jev молчит (null) или regex не сработал — операцию не
 * блокируем. Агент не должен вставать из-за падения API.
 */

const { loadConfig } = require("./config");
const client = require("./client");

const DEFAULT_SECRETS_THRESHOLD = 0.8;
const DEFAULT_SURGICAL_THRESHOLD = 0.2;

// Детерминированные сигнатуры секретов/токенов/учётных данных.
// Калибровка: паттерны ловят ЛИТЕРАЛЫ секретов, а не обычный код.
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key ID
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, // GitHub token
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bxox[baprs]-[0-9A-Za-z-]{10,}/, // Slack token
  // JWT: три сегмента base64url с не-base64 терминатором — раньше форма
  // \beyJ…\.\w… ловила любые хешеподобные строки (ложные блокировки).
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}={0,2}(?![A-Za-z0-9_-])/,
];

// sk-ключи (OpenAI/Anthropic-style). Широкий захват, поэтому значения с
// признаками плейсхолдера из доков/.env.template ниже ОТБРАКОВЫВАЮТСЯ —
// иначе гард блокирует легитимные правки примеров конфигурации.
const SK_RE = /\bsk-[A-Za-z0-9_-]{16,}/g;

// Имена секретов в конфигах (.env и подобных): проверяем именно ЗНАЧЕНИЕ.
const SECRET_ASSIGN = /\b(?:OPENROUTER_API_KEY|TYPESAFE_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|API_KEY|APITOKEN|SECRET_KEY|SECRET_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD|PASSWD|PRIVATE_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)\s*[:=]\s*["']?([^\s"']{8,})/i;
// Ссылочное значение — это код, а не секрет: $VAR, %{...}, {var}, env-lookup.
const VALUE_IS_REF = /^(?:[$%{]|\{)|^(?:os\.environ|process\.env|ENV|env|config|settings|self|this)\b/i;
// Плейсхолдеры/примеры: sk-your-key, sk-example…, заглушки. `\btest\b` — со
// словной границей, иначе ложно проскакивали бы ключи с «latest» внутри.
const PLACEHOLDER = /xxx|your[-_]|placeholder|dummy|sample|example|changeme|todo|my[-_]key|\btest\b|\btest[-_]/i;

function hasSecretSignature(text) {
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }

  let m;
  while ((m = SK_RE.exec(text)) !== null) {
    if (!PLACEHOLDER.test(m[0])) {
      SK_RE.lastIndex = 0;
      return true;
    }
  }
  SK_RE.lastIndex = 0;

  const assign = text.match(SECRET_ASSIGN);
  if (assign && !VALUE_IS_REF.test(assign[1]) && !PLACEHOLDER.test(assign[1])) return true;

  return false;
}

// Собирает читаемый патч/текст замены из аргументов инструмента.
// Если содержательных частей нет — возвращает null («нечего проверять»),
// а НЕ сериализует весь input в JSON (никакого мусора модели).
function extractDiff(input) {
  if (input == null) return null;
  const parts = [];
  const push = (s) => { if (typeof s === "string" && s.trim()) parts.push(s.trim()); };

  // ctx_patch: find/replace, old_text/new_text
  push(input.find);
  push(input.replace);
  push(input.old_text);
  push(input.new_text);
  // ctx_edit: old_string/new_string
  push(input.old_string);
  push(input.new_string);
  // write: content
  push(input.content);
  // apply_patch (pi-mono-multi-edit v2): весь дифф в поле `input`
  push(input.input);
  // multi-edit `patch`-режим (Codex-style *** Begin Patch ***): весь дифф в `patch`
  push(input.patch);

  // edit: { edits: [{oldText, newText}] }
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (!e) continue;
      push(e.oldText);
      push(e.newText);
    }
  }
  // multi-edit: { multi: [{oldText, newText}] }
  if (Array.isArray(input.multi)) {
    for (const e of input.multi) {
      if (!e) continue;
      push(e.oldText);
      push(e.newText);
    }
  }

  return parts.length ? parts.join("\n---\n") : null;
}

/**
 * Создаёт обработчик хука `tool_call`.
 * @param {object} deps { ask: async ({state, questions}) => answers|null,
 *                        config?: объект из loadConfig() }
 */
function createDiffGuard({ ask, config }) {
  const cfg = { ...loadConfig(), ...(config || {}) };
  const targetTools = new Set(cfg.diffTools);
  const stats = { checked: 0, blocked: 0, blockedByRegex: 0, blockedByJev: 0, warned: 0 };

  async function toolCallHandler(event, ctx) {
    const name = event && event.toolName;
    if (!targetTools.has(name)) return undefined;

    const diff = extractDiff(event.input);
    if (!diff) return undefined; // нечего проверять — не дёргаем Jev

    stats.checked += 1;

    // Слой 1: детерминированный regex — мгновенный блок без API.
    if (cfg.secretsRegexEnabled && hasSecretSignature(diff)) {
      stats.blocked += 1;
      stats.blockedByRegex += 1;
      return {
        block: true,
        reason: "BLOCKED by jev-guard: deterministic secret pattern detected (regex layer).",
      };
    }

    // Слой 2: Jev.
    let answers = null;
    try {
      answers = await ask({
        state: diff,
        questions: client.diffQuestions(),
      });
    } catch (err) {
      // Fail-soft: падение API — не блокируем.
      return undefined;
    }

    const sp = answers ? client.answerValue(answers.modifies_secrets) : null;
    if (typeof sp === "number" && sp > cfg.secretsThreshold) {
      stats.blocked += 1;
      stats.blockedByJev += 1;
      return {
        block: true,
        reason: "BLOCKED by jev-guard: attempt to modify secrets or credentials.",
      };
    }

    // Слой 3: is_surgical — advisory. Ядро из tool_call понимает только
    // block/reason/terminate, поэтому «предупрежение» доставляем через
    // ctx.ui.notify (TUI-тост) + лог, а не полем `warn` (его ядро игнорит).
    const surg = answers ? client.answerValue(answers.is_surgical) : null;
    if (cfg.surgicalAction === "warn" && typeof surg === "number" && surg < cfg.surgicalThreshold) {
      stats.warned += 1;
      const msg = `jev-guard: несужительная правка (${name}, is_surgical=${surg.toFixed(2)}) — похоже на drive-by рефакторинг`;
      client.log.warn(msg);
      try {
        if (ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(msg, "warning");
      } catch { /* UI не обязан быть доступен */ }
    }
    return undefined;
  }

  return {
    toolCallHandler,
    stats,
    targetTools,
    secretsThreshold: cfg.secretsThreshold,
    surgicalThreshold: cfg.surgicalThreshold,
  };
}

module.exports = {
  createDiffGuard,
  extractDiff,
  hasSecretSignature,
  SECRET_PATTERNS,
  DEFAULT_SECRETS_THRESHOLD,
  DEFAULT_SURGICAL_THRESHOLD,
};
