"use strict";

/**
 * jev-guard / test/run.js — быстрые автономные юнит-тесты (без интернета).
 *
 * Покрытие:
 *   1. Структура запроса questions (инструкции на английском).
 *   2. Парсинг ответа noul и порог has_actionable_error < 0.20.
 *   3. Сворачивание успешного длинного вывода bash.
 *   4. Сохранение вывода с ошибкой (isError / Jev-ошибка) без изменений.
 *   5. Блокировка диффа при modifies_secrets > 0.80.
 *   6. Fail-Soft при ошибке сети / HTTP / таймауте / нет ключа.
 *
 * Запуск: node test/run.js
 */

const assert = require("assert");

const client = require("../lib/client");
const { createPruner, extractText, collapseLine, MAX_LENGTH, COLLAPSE_THRESHOLD } = require("../lib/pruner");
const { createDiffGuard, extractDiff, SECRETS_THRESHOLD } = require("../lib/diff_guard");

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, err });
      console.log(`  ✗ ${name}\n      ${(err && err.message) || err}`);
    });
}

// ============================================================================
// Хелперы: мок `fetch` и сброс env
// ============================================================================
const originalFetch = global.fetch;
const originalEnv = { ...process.env };

function mockFetch(impl) {
  global.fetch = impl;
}
function resetEnv() {
  process.env = { ...originalEnv };
}
function cleanup() {
  global.fetch = originalFetch;
  resetEnv();
}

function okResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}
function statusResponse(status) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve({}) });
}

// ============================================================================
// 1. CLIENT — структура запроса (инструкции на английском)
// ============================================================================
test("client: questions structure, English instructions, endpoint/model", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  let captured = null;
  mockFetch(async (url, opts) => {
    captured = { url, opts };
    return okResponse({
      answers: { has_actionable_error: { type: "noul", probability: 0.02 } },
    });
  });

  const q = client.hasActionableErrorQuestion();
  const answers = await client.askJev("161 passed, 0 failed", { has_actionable_error: q });

  assert.strictEqual(captured.url, "https://openrouter.ai/api/alpha/decisions");
  assert.strictEqual(JSON.parse(captured.opts.body).model, "typesafe/jev-1.13");
  assert.strictEqual(captured.opts.headers.Authorization, "Bearer test-or-key");
  assert.strictEqual(captured.opts.signal instanceof AbortSignal, true);

  const body = JSON.parse(captured.opts.body);
  assert.strictEqual(body.questions.has_actionable_error.type, "noul");
  // instructions/criteria строго на английском
  assert.ok(/^Does this terminal output contain/.test(body.questions.has_actionable_error.instructions));
  assert.ok(!/[а-яА-Я]/.test(body.questions.has_actionable_error.instructions));
  // noul-парсинг
  assert.strictEqual(answers.has_actionable_error.probability, 0.02);
});

test("client: direct typesafe URL when TYPESAFE_API_KEY set", async () => {
  resetEnv();
  process.env.TYPESAFE_API_KEY = "ts-key";
  delete process.env.OPENROUTER_API_KEY;
  let captured = null;
  mockFetch(async (url) => {
    captured = url;
    return okResponse({ answers: {} });
  });
  await client.askJev("x", {});
  assert.strictEqual(captured, "https://api.typesafe.ai/v1/decisions");
});

// ============================================================================
// 2. CLIENT — fail-soft
// ============================================================================
test("client: fail-soft returns null on network error (no throw)", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
  const out = await client.askJev("x", {});
  assert.strictEqual(out, null);
});

test("client: fail-soft returns null on HTTP 404 (OpenRouter privacy)", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => statusResponse(404));
  const out = await client.askJev("x", {});
  assert.strictEqual(out, null);
});

test("client: fail-soft returns null on HTTP 429", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => statusResponse(429));
  const out = await client.askJev("x", {});
  assert.strictEqual(out, null);
});

test("client: fail-soft returns null on timeout (AbortError)", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => {
    const e = new Error("aborted");
    e.name = "AbortError";
    return Promise.reject(e);
  });
  const out = await client.askJev("x", {}, { timeoutMs: 2000 });
  assert.strictEqual(out, null);
});

test("client: fail-soft returns null when no API key", async () => {
  resetEnv();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let fetchCalled = false;
  mockFetch(() => {
    fetchCalled = true;
    return Promise.resolve(okResponse({ answers: {} }));
  });
  const out = await client.askJev("x", {}, { auth: null }); // симулируем отсутствие ключа
  assert.strictEqual(out, null); // ключа нет — не ходим в сеть
  assert.strictEqual(fetchCalled, false);
});

// ============================================================================
// 3. PRUNER
// ============================================================================
function longOutput() {
  return Array.from({ length: 200 }, (_, i) => `line ${i}: some build output`).join("\n");
}

test("pruner: collapses long successful output (p=0.02 < 0.20)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.02 } }),
  });
  const out = Array.from({ length: 200 }, (_, i) => `line ${i}: some build output`).join("\n");
  const res = await pruner.toolResultHandler({ toolName: "bash", content: out, isError: false });
  assert.ok(res && typeof res.content === "string");
  assert.ok(/^\[Output collapsed by jev-guard: 200 lines of successful output, exit code 0\]$/.test(res.content));
  assert.strictEqual(pruner.stats.collapsed, 1);
});

test("pruner: keeps short output (<800) untouched", async () => {
  const pruner = createPruner({ ask: async () => ({ has_actionable_error: { probability: 0 } }) });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: "ok", isError: false });
  assert.strictEqual(res, undefined);
  assert.strictEqual(pruner.stats.checked, 0);
});

test("pruner: keeps isError=true untouched even if long", async () => {
  const pruner = createPruner({ ask: async () => ({ has_actionable_error: { probability: 0 } }) });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: true });
  assert.strictEqual(res, undefined);
});

test("pruner: keeps output when Jev detects error (p=0.9 >= 0.20)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.9 } }),
  });
  const res = await pruner.toolResultHandler({ toolName: "ctx_shell", content: longOutput(), isError: false });
  assert.strictEqual(res, undefined);
  assert.strictEqual(pruner.stats.collapsed, 0);
});

test("pruner: fail-soft keeps output when ask returns null", async () => {
  const pruner = createPruner({ ask: async () => null });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: false });
  assert.strictEqual(res, undefined);
});

test("pruner: ignores non-target tools", async () => {
  const pruner = createPruner({ ask: async () => ({ has_actionable_error: { probability: 0 } }) });
  const res = await pruner.toolResultHandler({ toolName: "read", content: longOutput(), isError: false });
  assert.strictEqual(res, undefined);
});

test("pruner: collapseLine format", () => {
  assert.strictEqual(
    collapseLine(450),
    "[Output collapsed by jev-guard: 450 lines of successful output, exit code 0]"
  );
});

// ============================================================================
// 4. DIFF GUARD
// ============================================================================
test("diff_guard: blocks when modifies_secrets=0.95 (> 0.80)", async () => {
  const g = createDiffGuard({
    ask: async () => ({
      modifies_secrets: { type: "noul", probability: 0.95 },
      is_surgical: { type: "noul", probability: 0.1 },
    }),
  });
  const res = await g.toolCallHandler({
    toolName: "edit",
    input: { edits: [{ oldText: "a", newText: "OPENROUTER_API_KEY=secret123" }] },
  });
  assert.ok(res && res.block === true);
  assert.ok(res.reason.includes("BLOCKED by jev-guard"));
  assert.strictEqual(g.stats.blocked, 1);
});

test("diff_guard: does not block benign diff (p=0.1)", async () => {
  const g = createDiffGuard({
    ask: async () => ({
      modifies_secrets: { type: "noul", probability: 0.1 },
      is_surgical: { type: "noul", probability: 0.95 },
    }),
  });
  const res = await g.toolCallHandler({
    toolName: "ctx_patch",
    input: { find: "foo()", replace: "foo(bar)" },
  });
  assert.strictEqual(res, undefined);
  assert.strictEqual(g.stats.blocked, 0);
});

test("diff_guard: fail-soft does not block when ask returns null", async () => {
  const g = createDiffGuard({ ask: async () => null });
  const res = await g.toolCallHandler({
    toolName: "multi-edit",
    input: { multi: [{ oldText: "a", newText: "b" }] },
  });
  assert.strictEqual(res, undefined);
});

test("diff_guard: ignores non-target tools", async () => {
  const g = createDiffGuard({ ask: async () => ({ modifies_secrets: { probability: 0.99 } }) });
  const res = await g.toolCallHandler({ toolName: "bash", input: { command: "ls" } });
  assert.strictEqual(res, undefined);
});

test("diff_guard: extractDiff pulls oldText/newText from edits", () => {
  const d = extractDiff({ path: "x.js", edits: [{ oldText: "old", newText: "new" }] });
  assert.ok(d.includes("old") && d.includes("new"));
});

test("threshold constants exported", () => {
  assert.strictEqual(MAX_LENGTH, 800);
  assert.strictEqual(COLLAPSE_THRESHOLD, 0.2);
  assert.strictEqual(SECRETS_THRESHOLD, 0.8);
});

// ============================================================================
// RUN
// ============================================================================
setTimeout(() => {
  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      console.error(`\nFAILED: ${f.name}\n  ${f.err && f.err.stack ? f.err.stack : f.err}`);
    }
    process.exit(1);
  }
  process.exit(0);
}, 50);
