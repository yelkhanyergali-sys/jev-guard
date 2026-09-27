"use strict";

/**
 * jev-guard / lib/config.js — runtime-настройка расширения.
 *
 * Все пороги и наборы инструментов настраиваются через переменные окружения
 * с префиксом JEV_GUARD_ (у каждого есть разумный дефолт). Это позволяет
 * крутить поведение под разные проекты без правки кода.
 *
 *   JEV_GUARD_ENABLED             on/off                          (default on)
 *   JEV_GUARD_MAX_LENGTH          сжимать вывод длиннее этого       (default 4000)
 *   JEV_GUARD_PREVIEW_LINES       строк head/tail в превью           (default 10)
 *   JEV_GUARD_COLLAPSE_THRESHOLD  has_actionable_error < этого      (default 0.20)
 *   JEV_GUARD_SECRETS_THRESHOLD   modifies_secrets > этого → блок   (default 0.80)
 *   JEV_GUARD_SURGICAL_THRESHOLD  is_surgical < этого → warn       (default 0.20)
 *   JEV_GUARD_SURGICAL_ACTION     warn | off                       (default warn)
 *   JEV_GUARD_PRUNER_TOOLS        csv список инструментов прунера   (default см. ниже)
 *   JEV_GUARD_DIFF_TOOLS          csv список инструментов дифф-гарда(default см. ниже)
 *   JEV_GUARD_SECRETS_REGEX       on/off детерминированный regex    (default on)
 *   JEV_GUARD_LOG                 путь к лог-файлу                  (default ~/.pi/agent/jev-guard.log)
 */

const os = require("os");
const path = require("path");
const { parseEnvFile } = require("./client");

const PREFIX = "JEV_GUARD_";

// Слитая env-карта: .env-файлы как base, переменные сессии (process.env)
// имеют приоритет. Так пороги/тулы можно класть и в ~/.pi/agent/.env —
// удобство, а не обязательство (документированы и как env-переменные).
function mergedEnv() {
  const home = os.homedir();
  const m = {
    ...parseEnvFile(path.join(home, ".pi", "agent", ".env")),
    ...parseEnvFile(path.join(home, ".librefang", "secrets.env")),
  };
  for (const k of Object.keys(process.env)) m[k] = process.env[k];
  return m;
}

function envBool(env, name, def) {
  const v = env[PREFIX + name];
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function envNum(env, name, def) {
  const v = env[PREFIX + name];
  if (v === undefined || v === "") return def;
  const n = Number(v.trim());
  return Number.isNaN(n) ? def : n;
}

function envList(env, name, def) {
  const v = env[PREFIX + name];
  if (v === undefined || v === "") return def.slice();
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadConfig(overrides) {
  const env = mergedEnv();
  const cfg = {
    enabled: envBool(env, "ENABLED", true),
    // pruner
    prunerMaxLength: envNum(env, "MAX_LENGTH", 4000),
    prunerPreviewLines: envNum(env, "PREVIEW_LINES", 10),
    collapseThreshold: envNum(env, "COLLAPSE_THRESHOLD", 0.2),
    // Только шелл: успешный вывод grep/find/ls — это сами данные, не шум.
    prunerTools: envList(env, "PRUNER_TOOLS", [
      "bash", "shell", "powershell",
      "ctx_shell", "ctx_execute",
    ]),
    // diff guard
    secretsThreshold: envNum(env, "SECRETS_THRESHOLD", 0.8),
    surgicalThreshold: envNum(env, "SURGICAL_THRESHOLD", 0.2),
    surgicalAction: (env[PREFIX + "SURGICAL_ACTION"] || "warn").trim().toLowerCase(),
    diffTools: envList(env, "DIFF_TOOLS", [
      "edit", "write",
      "ctx_edit", "ctx_patch",
      "multi-edit", "multi_file_edit", "apply_patch",
    ]),
    secretsRegexEnabled: envBool(env, "SECRETS_REGEX", true),
    ...(overrides || {}),
  };
  if (cfg.surgicalAction !== "warn" && cfg.surgicalAction !== "off") cfg.surgicalAction = "warn";
  return cfg;
}

// Путь к лог-файлу: JEV_GUARD_LOG (env или .env), иначе ~/.pi/agent/jev-guard.log.
// Тесты обязаны переопределять его во временную директорию — иначе шумят в бою.
function logPath() {
  const env = mergedEnv();
  const custom = env[PREFIX + "LOG"];
  if (custom && custom.trim()) return custom.trim();
  return path.join(os.homedir(), ".pi", "agent", "jev-guard.log");
}

module.exports = { loadConfig, logPath, envBool, envNum, envList, PREFIX };
