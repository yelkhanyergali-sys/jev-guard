"use strict";

/**
 * jev-guard / lib/config.js — runtime-настройка расширения.
 *
 * Все пороги и наборы инструментов настраиваются через переменные окружения
 * с префиксом JEV_GUARD_ (у каждого есть разумный дефолт). Это позволяет
 * крутить поведение под разные проекты без правки кода.
 *
 *   JEV_GUARD_ENABLED             on/off                          (default on)
 *   JEV_GUARD_MAX_LENGTH          сворачивать вывод длиннее этого   (default 800)
 *   JEV_GUARD_COLLAPSE_THRESHOLD  has_actionable_error < этого      (default 0.20)
 *   JEV_GUARD_SECRETS_THRESHOLD   modifies_secrets > этого → блок   (default 0.80)
 *   JEV_GUARD_SURGICAL_THRESHOLD  is_surgical < этого → warn       (default 0.20)
 *   JEV_GUARD_SURGICAL_ACTION     warn | off                       (default warn)
 *   JEV_GUARD_PRUNER_TOOLS        csv список инструментов прунера   (default см. ниже)
 *   JEV_GUARD_DIFF_TOOLS          csv список инструментов дифф-гарда(default см. ниже)
 *   JEV_GUARD_SECRETS_REGEX       on/off детерминированный regex    (default on)
 */

const PREFIX = "JEV_GUARD_";

function envBool(name, def) {
  const v = process.env[PREFIX + name];
  if (v === undefined || v === "") return def;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

function envNum(name, def) {
  const v = process.env[PREFIX + name];
  if (v === undefined || v === "") return def;
  const n = Number(v.trim());
  return Number.isNaN(n) ? def : n;
}

function envList(name, def) {
  const v = process.env[PREFIX + name];
  if (v === undefined || v === "") return def.slice();
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadConfig(overrides) {
  const cfg = {
    enabled: envBool("ENABLED", true),
    // pruner
    prunerMaxLength: envNum("MAX_LENGTH", 800),
    collapseThreshold: envNum("COLLAPSE_THRESHOLD", 0.2),
    prunerTools: envList("PRUNER_TOOLS", [
      "bash", "shell", "powershell",
      "ctx_shell", "ctx_execute",
      "grep", "ctx_grep", "find", "ctx_find", "ls",
    ]),
    // diff guard
    secretsThreshold: envNum("SECRETS_THRESHOLD", 0.8),
    surgicalThreshold: envNum("SURGICAL_THRESHOLD", 0.2),
    surgicalAction: (process.env[PREFIX + "SURGICAL_ACTION"] || "warn").trim().toLowerCase(),
    diffTools: envList("DIFF_TOOLS", [
      "edit", "multi-edit", "ctx_patch", "ctx_edit", "write",
    ]),
    secretsRegexEnabled: envBool("SECRETS_REGEX", true),
    ...(overrides || {}),
  };
  if (cfg.surgicalAction !== "warn" && cfg.surgicalAction !== "off") cfg.surgicalAction = "warn";
  return cfg;
}

module.exports = { loadConfig, envBool, envNum, envList, PREFIX };
