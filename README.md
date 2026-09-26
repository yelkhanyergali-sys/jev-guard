# jev-guard

Расширение **PI Mono**, использующее модель **Jev** (TypeSafe AI) — первый в мире
**System One** вероятностный классификатор (НЕ LLM). Jev не генерирует текст,
а отвечает строго типизированными числами/вероятностями на карту вопросов.

Задержка 70–250 мс, $0.042/1M входных токенов, выход бесплатный.

## Две защитные роли

### 1. PRUNER — In-Flight Terminal Pruning (хук `tool_result`)
Перехватывает `bash` и `ctx_shell`. Успешный вывод длиннее **800** символов
проверяется вопросом `has_actionable_error`. Если ошибок нет
(`probability < 0.20`) — вывод сворачивается в одну строку:

```
[Output collapsed by jev-guard: 450 lines of successful output, exit code 0]
```

**Prompt Cache на 100%:** подмена происходит на самом свежем хвосте хода, ДО
записи результата в историю сессии. Весь предшествующий префикс остаётся
байт-в-байт стабильным — кэш-хит не сбрасывается.

Ошибки (`event.isError === true`) никогда не трогаются.

### 2. DIFF GUARD — Surgical Diff Guard (хук `tool_call`)
Перехватывает `edit`, `ctx_patch`, `multi-edit`. Задаёт Jev два параллельных
вопроса: `modifies_secrets` и `is_surgical`. Если `modifies_secrets > 0.80` —
операция **блокируется**:

```
BLOCKED by jev-guard: attempt to modify secrets or credentials.
```

## Fail-Soft

Любой сбой (таймаут 2с, 404 по политике приватности OpenRouter, 429, нет ключа)
логируется как warning и возвращает `null`. Агент **никогда** не блокируется и
не теряет логи из-за падения Jev API.

## API-ключ (приоритет)

1. `TYPESAFE_API_KEY` (env) → прямой URL `https://api.typesafe.ai/v1/decisions`
2. `OPENROUTER_API_KEY` (env)
3. `OPENROUTER_API_KEY` в `~/.pi/agent/.env`
4. `OPENROUTER_API_KEY` в `~/.librefang/secrets.env`

Эндпоинт по умолчанию: `POST https://openrouter.ai/api/alpha/decisions`,
модель `typesafe/jev-1.13`. Таймаут **строго 2 секунды**
(`AbortSignal.timeout(2000)`).

> ⚠️ Поля `instructions`/`criteria` во всех вопросах — **только на английском**
> языке (калибровка Jev/RLCD оптимизирована под английский).

## Команды

- `/jev status` — счётчики (проверено/свёрнуто логов, проверено/заблокировано
  диффов) и статус API-ключа.

## Структура

```
jev-guard/
├── package.json
├── README.md
├── index.js            # точка входа: регистрация хуков и /jev status
├── lib/
│   ├── client.js       # HTTP-клиент к Jev Decisions API (таймаут 2с, fail-soft)
│   ├── pruner.js       # In-Flight Pruning вывода bash/ctx_shell
│   └── diff_guard.js   # Surgical Diff Guard для edit/ctx_patch
└── test/
    └── run.js          # автономные юнит-тесты (моки Jev)
```

## Тесты

```bash
node ~/.pi/agent/extensions/jev-guard/test/run.js
```
