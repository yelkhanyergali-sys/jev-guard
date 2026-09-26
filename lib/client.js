"use strict";

/**
 * jev-guard / lib/client.js — HTTP-клиент к Jev Decisions API.
 *
 * Jev от TypeSafe AI — System One вероятностный классификатор (НЕ LLM).
 * Она не генерирует текст, а возвращает строго типизированные ответы
 * (числа/вероятности/ключи опций) на карту вопросов `questions`.
 *
 * - Эндпоинт: POST https://openrouter.ai/api/alpha/decisions
 * - Модель:   typesafe/jev-1.13
 * - Язык:     поля `instructions`/`criteria` — ТОЛЬКО английский
 *   (калибровка Jev построена на англоязычных деревьях решений RLCD).
 * - Таймаут:  строго 2 секунды (AbortSignal.timeout(2000)).
 * - Fail-Soft: любая ошибка (таймаут, 404 по политике приватности OpenRouter,
 *   429, нет ключа) логируется как warning и возвращается `null` — агент
 *   никогда не блокируется из-за падения API.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const OR_URL = "https://openrouter.ai/api/alpha/decisions";
const TS_URL = "https://api.typesafe.ai/v1/decisions";
const MODEL = "typesafe/jev-1.13";
const DEFAULT_TIMEOUT_MS = 2000; // строго 2 секунды

// ---- логирование (тихий fallback, никогда не падаем) ----
const log = {
  warn(...args) {
    try {
      const line = `[jev-guard] ${new Date().toISOString()} WARN ${args.join(" ")}\n`;
      if (typeof console !== "undefined" && console.warn) console.warn(line.trimEnd());
      try {
        fs.appendFileSync(path.join(os.homedir(), ".pi", "agent", "jev-guard.log"), line, "utf8");
      } catch { /* лог не критичен */ }
    } catch { /* noop */ }
  },
};

// ---- парсинг простых KEY=VALUE env-файлов ----
function parseEnvFile(filePath) {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const out = {};
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Резолв API-ключа по приоритету:
 *   1. process.env.TYPESAFE_API_KEY        → прямой URL typesafe
 *   2. process.env.OPENROUTER_API_KEY      → OpenRouter
 *   3. ~/.pi/agent/.env (OPENROUTER_API_KEY)
 *   4. ~/.librefang/secrets.env (OPENROUTER_API_KEY)
 * Возвращает { key, direct } или null.
 */
function resolveApiKey() {
  try {
    if (process.env.TYPESAFE_API_KEY) return { key: process.env.TYPESAFE_API_KEY, direct: true };
    if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, direct: false };

    const home = os.homedir();
    const envPi = parseEnvFile(path.join(home, ".pi", "agent", ".env"));
    if (envPi.OPENROUTER_API_KEY) return { key: envPi.OPENROUTER_API_KEY, direct: false };

    const envSec = parseEnvFile(path.join(home, ".librefang", "secrets.env"));
    if (envSec.OPENROUTER_API_KEY) return { key: envSec.OPENROUTER_API_KEY, direct: false };

    return null;
  } catch {
    return null;
  }
}

/**
 * Единственная точка входа: послать `state` + карту `questions` в Jev.
 *
 * @param {string} state  сырые данные до ~32k токенов (лог, код, git diff)
 * @param {object} questions карта типизированных вопросов (noul/choice/score)
 * @param {object} [opts] { timeoutMs }
 * @returns {Promise<object|null>} объект `answers` или null (fail-soft).
 */
async function askJev(state, questions, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  try {
    // opts.auth — тестовая/прикладная инъекция; по умолчанию — обычный резолв.
    const auth = opts.auth !== undefined ? opts.auth : resolveApiKey();
    if (!auth) {
      log.warn("no API key (checked env, ~/.pi/agent/.env, ~/.librefang/secrets.env); fail-soft null");
      return null;
    }
    const url = auth.direct ? TS_URL : OR_URL;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.key}`,
        },
        body: JSON.stringify({ model: MODEL, state: state, questions: questions }),
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn(`Jev HTTP ${res.status} (fail-soft null)`);
        return null;
      }
      const data = await res.json();
      return data && data.answers ? data.answers : null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err && err.name === "AbortError"
      ? `timeout after ${timeoutMs}ms`
      : String((err && err.message) || err);
    log.warn(`request failed (${msg}); fail-soft null`);
    return null;
  }
}

// ---- готовые строительные блоки вопросов (инструкции — на английском) ----
function noulQuestion(instructions, criteriaTrue, criteriaFalse) {
  return {
    type: "noul",
    instructions,
    criteria: { true: criteriaTrue, false: criteriaFalse },
  };
}

// Вопрос для сворачивания вывода терминала (pruner).
function hasActionableErrorQuestion() {
  return noulQuestion(
    "Does this terminal output contain an error, failure, crash, compilation issue, or broken test that requires fixing?",
    "The output indicates a failure, exception, crash, or broken test.",
    "The output indicates clean success, normal passing tests, or standard informational logs."
  );
}

// Вопросы для дифф-гарда (modifies_secrets + is_surgical).
function diffQuestions() {
  return {
    modifies_secrets: noulQuestion(
      "Does this diff modify passwords, secret keys, .env credentials, or private certificates?",
      "Modifies sensitive tokens or credentials.",
      "Standard application code."
    ),
    is_surgical: noulQuestion(
      "Does this diff focus strictly on the necessary change without drive-by refactoring of unrelated code, comments, or formatting?",
      "Clean and surgical modification.",
      "Unnecessary reformatting or touching unrelated lines."
    ),
  };
}

module.exports = {
  MODEL,
  OR_URL,
  TS_URL,
  DEFAULT_TIMEOUT_MS,
  resolveApiKey,
  askJev,
  noulQuestion,
  hasActionableErrorQuestion,
  diffQuestions,
  log,
};
