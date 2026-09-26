"use strict";

/**
 * jev-guard — расширение PI Mono.
 *
 * Jev (TypeSafe AI) — System One вероятностный классификатор (НЕ LLM):
 * не генерирует текст, а отвечает строго типизированными вероятностями.
 * Расширение использует Jev в двух защитных ролях:
 *
 *  1) PRUNER — In-Flight Terminal Pruning (tool_result для bash/ctx_shell).
 *     Успешный длинный вывод (>800 символов) сворачивается в одну строку,
 *     если Jev не нашёл ошибок (has_actionable_error < 0.20). Экономит токены
 *     и сохраняет Prompt Cache на 100% (подмена только на хвосте хода).
 *
 *  2) DIFF GUARD — Surgical Diff Guard (tool_call для edit/ctx_patch/multi-edit).
 *     Блокирует изменение секретов/токенов/учётных данных
 *     (modifies_secrets > 0.80).
 *
 * Обе роли fail-soft: если Jev недоступен/таймаутит/нет ключа — агент
 * продолжает работу без блокировок и без потери логов.
 */

const client = require("./lib/client");
const { createPruner } = require("./lib/pruner");
const { createDiffGuard } = require("./lib/diff_guard");

module.exports = function (pi) {
  // Единая точка вызова Jev: state + вопросы → answers (или null при fail-soft).
  const ask = (o) => client.askJev(o.state, o.questions);

  const pruner = createPruner({ ask });
  const diffGuard = createDiffGuard({ ask });

  // PRUNER: сворачивание длинного успешного вывода терминала.
  pi.on("tool_result", pruner.toolResultHandler);

  // DIFF GUARD: блокировка правок секретов.
  pi.on("tool_call", diffGuard.toolCallHandler);

  pi.registerCommand("jev", {
    description: "Jev guard: статус (свёртка логов, блокировка диффов, API-ключ)",
    handler: (args, ctx) => {
      const arg = (args || "").trim();
      if (arg && arg.split(/\s+/)[0].toLowerCase() !== "status") {
        console.log("[jev-guard] usage: /jev status");
        return;
      }
      const lines = [
        "[jev-guard] Jev System One classifier guard",
        `  tool results checked:  ${pruner.stats.checked}`,
        `  tool results collapsed:${pruner.stats.collapsed}`,
        `  diffs checked:         ${diffGuard.stats.checked}`,
        `  diffs blocked:         ${diffGuard.stats.blocked}`,
        `  api key:               ${client.resolveApiKey() ? "configured" : "MISSING (fail-soft)"}`,
      ];
      console.log(lines.join("\n"));
    },
  });
};
