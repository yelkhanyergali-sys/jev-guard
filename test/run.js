"use strict";

/**
 * jev-guard / test/run.js — быстрые автономные юнит-тесты (без интернета).
 *
 * Покрытие:
 *   1. Структура запроса questions (инструкции на английском).
 *   2. Парсинг ответа noul и порог has_actionable_error < 0.20.
 *   3. Сворачивание успешного длинного вывода терминала.
 *   4. Сохранение вывода с ошибкой (isError / Jev-ошибка) без изменений.
 *   5. Блокировка диффа (regex-слой + Jev-слой) при правке секретов.
 *   6. is_surgical → warn (advisory), не блокирует.
 *   7. Runtime-конфиг (JEV_GUARD_* env): пороги и наборы инструментов.
 *   8. Fail-Soft при ошибке сети / HTTP / таймауте / нет ключа.
 *   9. extractDiff не дампит пустой дифф в JSON.
 *
 * Запуск: node test/run.js
 */

const assert = require("assert");

const client = require("../lib/client");
const { loadConfig } = require("../lib/config");
const { createPruner, extractText, lineCount, collapseLine, DEFAULT_MAX_LENGTH, DEFAULT_COLLAPSE_THRESHOLD } = require("../lib/pruner");
const { createDiffGuard, extractDiff, hasSecretSignature, DEFAULT_SECRETS_THRESHOLD } = require("../lib/diff_guard");

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

function longOutput() {
  return Array.from({ length: 200 }, (_, i) => `line ${i}: some build output`).join("\n");
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
  assert.ok(/^Does this terminal output contain/.test(body.questions.has_actionable_error.instructions));
  assert.ok(!/[а-яА-Я]/.test(body.questions.has_actionable_error.instructions));
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
  assert.strictEqual(await client.askJev("x", {}), null);
});

test("client: fail-soft returns null on HTTP 404 (OpenRouter privacy)", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => statusResponse(404));
  assert.strictEqual(await client.askJev("x", {}), null);
});

test("client: fail-soft returns null on HTTP 429", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => statusResponse(429));
  assert.strictEqual(await client.askJev("x", {}), null);
});

test("client: fail-soft returns null on timeout (AbortError)", async () => {
  resetEnv();
  process.env.OPENROUTER_API_KEY = "test-or-key";
  mockFetch(() => {
    const e = new Error("aborted");
    e.name = "AbortError";
    return Promise.reject(e);
  });
  assert.strictEqual(await client.askJev("x", {}, { timeoutMs: 2000 }), null);
});

test("client: fail-soft returns null when no API key (no fetch)", async () => {
  resetEnv();
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let fetchCalled = false;
  mockFetch(() => {
    fetchCalled = true;
    return Promise.resolve(okResponse({ answers: {} }));
  });
  assert.strictEqual(await client.askJev("x", {}, { auth: null }), null);
  assert.strictEqual(fetchCalled, false);
});

// ============================================================================
// 3. PRUNER
// ============================================================================
test("pruner: collapses long successful output (p=0.02 < 0.20)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.02 } }),
  });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: false });
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
  assert.strictEqual(await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: true }), undefined);
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
  assert.strictEqual(await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: false }), undefined);
});

test("pruner: covers extended tools (ctx_execute, grep, find)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.01 } }),
  });
  for (const tool of ["ctx_execute", "grep", "find", "ls"]) {
    const res = await pruner.toolResultHandler({ toolName: tool, content: longOutput(), isError: false });
    assert.ok(res, `expected collapse for ${tool}`);
  }
});

test("pruner: ignores non-target tools (read)", async () => {
  const pruner = createPruner({ ask: async () => ({ has_actionable_error: { probability: 0 } }) });
  assert.strictEqual(await pruner.toolResultHandler({ toolName: "read", content: longOutput(), isError: false }), undefined);
});

test("pruner: respects runtime maxLength override (config)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.01 } }),
    config: { prunerMaxLength: 10, collapseThreshold: 0.2 },
  });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: "1234567890-extra-long", isError: false });
  assert.ok(res, "output longer than maxLength(10) should collapse");
});

test("pruner: respects runtime collapseThreshold override (config)", async () => {
  const pruner = createPruner({
    ask: async () => ({ has_actionable_error: { type: "noul", probability: 0.15 } }),
    config: { prunerMaxLength: 800, collapseThreshold: 0.1 },
  });
  const res = await pruner.toolResultHandler({ toolName: "bash", content: longOutput(), isError: false });
  assert.strictEqual(res, undefined, "0.15 >= 0.10 threshold → keep");
});

// ============================================================================
// 4. DIFF GUARD
// ============================================================================
test("diff_guard: Jev blocks when modifies_secrets=0.95 (> 0.80)", async () => {
  const g = createDiffGuard({
    ask: async () => ({
      modifies_secrets: { type: "noul", probability: 0.95 },
      is_surgical: { type: "noul", probability: 0.1 },
    }),
  });
  const res = await g.toolCallHandler({
    toolName: "edit",
    input: { edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.ok(res && res.block === true);
  assert.ok(res.reason.includes("BLOCKED by jev-guard"));
  assert.strictEqual(g.stats.blocked, 1);
  assert.strictEqual(g.stats.blockedByJev, 1);
});

test("diff_guard: regex layer blocks write of secret content (no Jev call)", async () => {
  let askCalls = 0;
  const g = createDiffGuard({
    ask: async () => { askCalls += 1; return { modifies_secrets: { probability: 0 } }; },
  });
  const res = await g.toolCallHandler({
    toolName: "write",
    input: { path: "creds.env", content: "OPENROUTER_API_KEY=sk-abc1234567890XYZ" },
  });
  assert.ok(res && res.block === true);
  assert.ok(res.reason.includes("regex layer"));
  assert.strictEqual(g.stats.blockedByRegex, 1);
  assert.strictEqual(askCalls, 0, "regex должен блокировать без обращения к Jev");
});

test("diff_guard: regex layer blocks sk- token", async () => {
  const g = createDiffGuard({ ask: async () => ({ modifies_secrets: { probability: 0 } }) });
  const res = await g.toolCallHandler({
    toolName: "ctx_patch",
    input: { find: "a", replace: "sk-abcdefghijklmnopqrstuvwxyz123456" },
  });
  assert.ok(res && res.block === true);
});

test("diff_guard: regex layer blocks PEM private key", async () => {
  assert.strictEqual(hasSecretSignature("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA"), true);
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

test("diff_guard: is_surgical low → warn (advisory, not block)", async () => {
  const g = createDiffGuard({
    ask: async () => ({
      modifies_secrets: { type: "noul", probability: 0.05 },
      is_surgical: { type: "noul", probability: 0.05 },
    }),
  });
  const res = await g.toolCallHandler({
    toolName: "edit",
    input: { edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.ok(res, "должен вернуть warn-объект");
  assert.ok(res.warn === true);
  assert.strictEqual(res.block, undefined, "warn НЕ должен блокировать");
  assert.ok(res.reason.includes("drive-by"));
  assert.strictEqual(g.stats.warned, 1);
});

test("diff_guard: surgicalAction=off disables is_surgical warn", async () => {
  const g = createDiffGuard({
    ask: async () => ({
      modifies_secrets: { type: "noul", probability: 0.05 },
      is_surgical: { type: "noul", probability: 0.05 },
    }),
    config: { surgicalAction: "off" },
  });
  const res = await g.toolCallHandler({
    toolName: "edit",
    input: { edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.strictEqual(res, undefined);
  assert.strictEqual(g.stats.warned, 0);
});

test("diff_guard: fail-soft does not block when ask returns null", async () => {
  const g = createDiffGuard({ ask: async () => null });
  assert.strictEqual(await g.toolCallHandler({
    toolName: "multi-edit",
    input: { multi: [{ oldText: "a", newText: "b" }] },
  }), undefined);
});

test("diff_guard: covers write tool via Jev layer (no regex hit)", async () => {
  const g = createDiffGuard({
    ask: async () => ({ modifies_secrets: { type: "noul", probability: 0.9 } }),
  });
  const res = await g.toolCallHandler({
    toolName: "write",
    input: { path: "x.txt", content: "plain file content" },
  });
  assert.ok(res && res.block === true, "write должен покрываться дифф-гардом");
});

test("diff_guard: ignores non-target tools (bash)", async () => {
  const g = createDiffGuard({ ask: async () => ({ modifies_secrets: { probability: 0.99 } }) });
  assert.strictEqual(await g.toolCallHandler({ toolName: "bash", input: { command: "ls" } }), undefined);
});

test("diff_guard: respects runtime secretsThreshold override (config)", async () => {
  const g = createDiffGuard({
    ask: async () => ({ modifies_secrets: { type: "noul", probability: 0.6 } }),
    config: { secretsThreshold: 0.5 },
  });
  const res = await g.toolCallHandler({
    toolName: "edit",
    input: { edits: [{ oldText: "a", newText: "b" }] },
  });
  assert.ok(res && res.block === true, "0.6 > threshold 0.5 → block");
});

// ============================================================================
// 5. extractDiff / config
// ============================================================================
test("extractDiff: pulls oldText/newText from edits", () => {
  const d = extractDiff({ path: "x.js", edits: [{ oldText: "old", newText: "new" }] });
  assert.ok(d.includes("old") && d.includes("new"));
});

test("extractDiff: returns null for empty/absent diff (no JSON dump)", () => {
  assert.strictEqual(extractDiff(null), null);
  assert.strictEqual(extractDiff({ path: "x.js" }), null);
  assert.strictEqual(extractDiff({}), null);
  assert.strictEqual(extractDiff({ path: "x.js", edits: [{ oldText: "  ", newText: "" }] }), null);
});

test("config: defaults and env override", () => {
  const def = loadConfig();
  assert.strictEqual(def.prunerMaxLength, 800);
  assert.strictEqual(def.collapseThreshold, 0.2);
  assert.strictEqual(def.secretsThreshold, 0.8);
  assert.ok(def.prunerTools.includes("ctx_execute"));
  assert.ok(def.diffTools.includes("write"));

  process.env.JEV_GUARD_MAX_LENGTH = "1200";
  process.env.JEV_GUARD_SECRETS_THRESHOLD = "0.9";
  process.env.JEV_GUARD_PRUNER_TOOLS = "bash,ctx_shell";
  process.env.JEV_GUARD_DIFF_TOOLS = "write";
  process.env.JEV_GUARD_SURGICAL_ACTION = "off";
  const c = loadConfig();
  assert.strictEqual(c.prunerMaxLength, 1200);
  assert.strictEqual(c.secretsThreshold, 0.9);
  assert.deepStrictEqual(c.prunerTools, ["bash", "ctx_shell"]);
  assert.deepStrictEqual(c.diffTools, ["write"]);
  assert.strictEqual(c.surgicalAction, "off");
  resetEnv();
});

test("defaults constants exported", () => {
  assert.strictEqual(DEFAULT_MAX_LENGTH, 800);
  assert.strictEqual(DEFAULT_COLLAPSE_THRESHOLD, 0.2);
  assert.strictEqual(DEFAULT_SECRETS_THRESHOLD, 0.8);
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
