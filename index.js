"use strict";

/**
 * jev-guard — расширение PI Mono.
 *
 * Jev (TypeSafe AI) — System One вероятностный классификатор (НЕ LLM):
 * не генерирует текст, а отвечает строго типизированными вероятностями.
 * Расширение использует Jev в двух защитных ролях:
 *
 *  1) PRUNER — In-Flight Terminal Pruning (tool_result для шелл-инструментов:
 *     bash/shell/powershell/ctx_shell/ctx_execute). Успешный длинный вывод
 *     (> maxLength) сжимается до head/tail-превью (первые и последние
 *     previewLines строк), если Jev не нашёл ошибок (has_actionable_error <
 *     collapseThreshold). Search-тулы (grep/find/ls) не трогаем: их успешный
 *     вывод — это данные, а не шум. Экономит токены и сохраняет Prompt Cache.
 *
 *  2) DIFF GUARD — Surgical Diff Guard (tool_call для edit/multi-edit/
 *     ctx_patch/ctx_edit/write). Два слоя защиты: детерминированный regex
 *     (sk-, AKIA, -----BEGIN PRIVATE KEY-----, присвоения *_KEY=) и Jev
 *     (modifies_secrets > secretsThreshold). is_surgical → warn (advisory).
 *
 * Все пороги и наборы инструментов настраиваются через env JEV_GUARD_*
 * (см. lib/config.js). Обе роли fail-soft: если Jev недоступен — агент
 * продолжает работу без блокировок и без потери логов.
 */

const client = require("./lib/client");
const { loadConfig } = require("./lib/config");
const { createPruner } = require("./lib/pruner");
const { createDiffGuard } = require("./lib/diff_guard");

module.exports = function (pi) {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    console.log("[jev-guard] disabled (JEV_GUARD_ENABLED=off)");
    return;
  }

  // Единая точка вызова Jev: state + вопросы → answers (или null при fail-soft).
  const ask = (o) => client.askJev(o.state, o.questions);

  const pruner = createPruner({ ask, config: cfg });
  const diffGuard = createDiffGuard({ ask, config: cfg });

  // PRUNER: сворачивание длинного успешного вывода терминала.
  pi.on("tool_result", pruner.toolResultHandler);

  // DIFF GUARD: блокировка правок секретов + warn на drive-by рефакторинг.
  pi.on("tool_call", diffGuard.toolCallHandler);

  pi.registerCommand("jev", {
    description: "Jev guard: статус (свёртка логов, блокировка диффов, пороги, regex, ключ)",
    handler: (args, ctx) => {
      const arg = (args || "").trim();
      if (arg && arg.split(/\s+/)[0].toLowerCase() !== "status") {
        console.log("[jev-guard] usage: /jev status");
        return;
      }
      const lines = [
        "[jev-guard] Jev System One classifier guard",
        `  tool results checked:   ${pruner.stats.checked}`,
        `  tool results compressed:${pruner.stats.collapsed} (saved ~${pruner.stats.savedChars} chars)`,
        `  diffs checked:          ${diffGuard.stats.checked}`,
        `  diffs blocked:          ${diffGuard.stats.blocked} (regex: ${diffGuard.stats.blockedByRegex}, jev: ${diffGuard.stats.blockedByJev})`,
        `  diffs warned (surgical):${diffGuard.stats.warned}`,
        `  pruner:  maxLen=${cfg.prunerMaxLength} chars, preview=${pruner.previewLines} lines h/t, collapse<${cfg.collapseThreshold}, tools=${cfg.prunerTools.join(",")}`,
        `  diff:    secrets>${cfg.secretsThreshold}, surgical<${cfg.surgicalThreshold} (action=${cfg.surgicalAction}), regex=${cfg.secretsRegexEnabled ? "on" : "off"}, tools=${cfg.diffTools.join(",")}`,
        `  api key:                ${client.resolveApiKey() ? "configured" : "MISSING (fail-soft)"}`,
        `  log:                    ${require("./lib/config").logPath()}`,
      ];
      console.log(lines.join("\n"));
    },
  });
};
