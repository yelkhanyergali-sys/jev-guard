# 🛡️ jev-guard

> **Ultra-fast In-Flight Terminal Pruning and Surgical Diff Guard for [PI Coding Agent](https://github.com/yelkhanyergali-sys/pi-mono), powered by Jev (TypeSafe AI) — the world's first System One decision model.**

[![Tests](https://img.shields.io/badge/tests-48%20passed-brightgreen.svg)](test/run.js)
[![Model](https://img.shields.io/badge/Jev-typesafe%2Fjev--1.13-orange.svg)](https://typesafe.ai)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Prompt Cache](https://img.shields.io/badge/Prompt%20Cache-100%25%20Safe-purple.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> **Status: not in use (kept as reference).** Since 2026-09-28 this extension is no
> longer listed in PI's `settings.json`, so it does not load. Terminal-output
> compression is handled by [`pi-lean-ctx`](https://github.com/yvgude/lean-ctx),
> which compresses at the source with measured metering instead of post-factum
> head/tail cutting, and covers `ctx_*` tools jev never reached. The diff guard
> here was also found to be theatre: a secret pasted into chat is already in the
> session context and already billed to the provider — blocking the file write
> hides nothing while interrupting legitimate work. Real leak control lives at the
> publish boundary instead. Code and tests are maintained for reference.

---

## ⚡ The Problem: Coding Agent Context Bloat & Cache Destruction

Modern AI coding agents (Claude Code, Cursor, PI Mono) suffer from three fundamental problems during heavy development sessions:

1. **Terminal Log Bloat:** Running `cargo test`, `pytest`, or `npm run build` dumps 500–1,000 lines of raw compiler/test logs into the conversation context. After 15 runs, **20,000+ tokens of pure boilerplate** pollute the context window, causing models to forget initial project instructions (*Lost in the Middle* effect).
2. **The Prompt Cache Trap:** Traditional compaction via LLMs summarizes past history. But retroactively rewriting older messages **breaks the frozen byte-prefix**, destroying 80–99% prompt cache hit rates and forcing expensive full-token re-billing.
3. **Accidental Credential Modifications (Drive-By Edits):** Agents occasionally hallucinate or over-edit, overwriting `.env` files, API keys, or certificates before human review.

`jev-guard` addresses all three with a typed decision model instead of an LLM —
and the pruning half is deliberately **surgical**: it only touches shell
output, keeps the informative head and tail, and never competes with the
context tool (`pi-lean-ctx`) that already truncates file/search results.
Manual `/compact` in PI Mono is untouched — jev-guard has no compaction hook.

---

## 💡 The Solution: Jev (System One Decision Model)

Created by Diogo Almeida (ex-OpenAI researcher and co-author of RLHF / InstructGPT), **Jev by TypeSafe AI** is fundamentally **NOT a traditional LLM**:
- 🚫 **No text generation:** Jev cannot hallucinate prose, break JSON quotes, or write conversational filler.
- ⚡ **Pure Decision Engine:** Given an application `state` (terminal log, diff, code up to 32k tokens) and typed `questions`, Jev returns calibrated mathematical probabilities (`noul`), categorical choices (`choice`), or ordinal ratings (`score`).
- ⏱️ **Sub-250ms Latency:** Forward-pass parallel sampling evaluates multiple questions in a single round-trip.
- 💸 **Insane Economics:** **$0.042 per 1M input tokens**, with **$0.00 output token billing** (output is free!).

---

## ✨ Key Features ("Все плюшки")

### 1. 🧹 In-Flight Terminal Pruning (lossy-safe head/tail)
- Intercepts **shell** tools only at the `tool_result` event boundary:
  `bash`, `shell`, `powershell`, `ctx_shell`, `ctx_execute`
  (set via `JEV_GUARD_PRUNER_TOOLS`). Search tools (`grep`, `find`, `ls`,
  `ctx_grep`, `ctx_find`) are deliberately **not** pruned — their successful
  output *is* the data the agent needs, and `pi-lean-ctx` already truncates
  it natively. One pruning layer, not two.
- If a command succeeds (`isError === false`) and the output exceeds
  `JEV_GUARD_MAX_LENGTH` (default 4000) characters **and** has more than
  `2 × JEV_GUARD_PREVIEW_LINES` lines, Jev evaluates:
  ```json
  "has_actionable_error": { "type": "noul", "instructions": "Does this terminal output contain an error or failure requiring fixing?" }
  ```
- If `has_actionable_error < JEV_GUARD_COLLAPSE_THRESHOLD` (default 0.20):
  the middle of the log is dropped, the head and tail are kept verbatim:
  ```text
  line 0: Compiling librefang-kernel v0.1.0
  ...first 10 lines...
  [... 180 lines omitted by jev-guard: clean output, exit code 0 ...]
  ...last 10 lines...
  Finished dev [unoptimized + debuginfo] target(s) in 42.13s
  ```
- **Why not a single collapsed line:** the first lines carry the command
  banner and the last carry the exit summary. Erasing everything made the
  agent re-run the command to see what it had just printed — costing more
  tokens than the pruning saved.

### 2. 🔒 100% Byte-Stable Prompt Cache Preservation
- **Why other pruners fail:** Modifying past history breaks the prefix cache.
- **How jev-guard succeeds:** Pruning occurs **in-flight at the very tail of the turn** *before* the message is appended to the session history array. The preceding conversation prefix remains 100% byte-for-byte identical. **Your 90%+ prompt cache hit rate never drops!**

### 3. 🚨 Surgical Diff & Secret Guard
- Intercepts file modification tools (`edit`, `write`, `ctx_edit`, `ctx_patch`,
  `multi-edit` / `multi_file_edit`, `apply_patch`) at the `tool_call` hook.
  Both v1 (`multi-edit`) and v2.0.0 (`multi_file_edit` + `apply_patch`) names
  of the pi-mono-multi-edit family are covered by default.
- **Two defense layers:**
  1. **Deterministic regex layer** (no network): known secret *literals*
     (`sk-...`, `AKIA...`, `-----BEGIN PRIVATE KEY-----`, GitHub/Google/Slack
     tokens, 3-segment JWT, `*_KEY=`/`PASSWORD=`/`SECRET=` assignments).
     Assignment values that are references (`$FOO`, `%{...}`, `os.environ`,
     `process.env`, `config.x`) or documentation placeholders
     (`sk-XXXX`, `sk-your-key-here`, `sk-example`) are **not** flagged —
     otherwise every legitimate `.env.example` edit gets blocked.
     A hit → **instant block** without a single Jev call.
     Toggle: `JEV_GUARD_SECRETS_REGEX`.
  2. **Jev layer:** `modifies_secrets`. If `> JEV_GUARD_SECRETS_THRESHOLD`
     (default 0.80), the operation is **immediately blocked before touching
     the disk**:
  ```text
  BLOCKED by jev-guard: attempt to modify secrets or credentials.
  ```
- **is_surgical (advisory):** second Jev question. When probability is low
  (`< JEV_GUARD_SURGICAL_THRESHOLD`, default 0.20) — suspected drive-by
  refactoring → **notification in the TUI** via `ctx.ui.notify(msg,
  "warning")` plus the log. It does NOT block: the PI core acts only on
  `block`, so a `{warn: true}` return value would be silently discarded.
  Controlled by `JEV_GUARD_SURGICAL_ACTION` (`warn` | `off`).

### 4. 🦺 Fail-Soft Architecture (Zero Workflow Interruption)
- Strict **2.0-second timeout** (`AbortSignal.timeout(2000)`).
- If OpenRouter, TypeSafe API, or the network encounters an error (HTTP 404, 429, timeout), `jev-guard` **never crashes or blocks the agent**. It logs a silent warning and passes the original output through untouched.
- **Bounded request size:** the `state` sent to Jev is capped at 12k
  characters (8k head + 4k tail). A 500 KB build log neither gets billed in
  full nor silently truncated at the API's 32k-token limit mid-decision.

### 6. ⚙️ Runtime Configuration (no code edits)
All thresholds and tool sets are tunable via env with the `JEV_GUARD_` prefix:

| Variable | Default | Description |
|---|---|---|
| `JEV_GUARD_ENABLED` | `on` | Enable/disable the extension |
| `JEV_GUARD_MAX_LENGTH` | `4000` | Prune output longer than this (chars) |
| `JEV_GUARD_PREVIEW_LINES` | `10` | Head/tail lines kept when pruning |
| `JEV_GUARD_COLLAPSE_THRESHOLD` | `0.20` | `has_actionable_error` below → prune |
| `JEV_GUARD_SECRETS_THRESHOLD` | `0.80` | `modifies_secrets` above → block |
| `JEV_GUARD_SURGICAL_THRESHOLD` | `0.20` | `is_surgical` below → notify |
| `JEV_GUARD_SURGICAL_ACTION` | `warn` | `warn` \| `off` |
| `JEV_GUARD_PRUNER_TOOLS` | shell tools | csv of pruner tools |
| `JEV_GUARD_DIFF_TOOLS` | list | csv of diff-guard tools |
| `JEV_GUARD_SECRETS_REGEX` | `on` | Deterministic regex secret layer |
| `JEV_GUARD_LOG` | `~/.pi/agent/jev-guard.log` | Log file path (also how tests stay out of the real log) |

All thresholds and tool sets can also be placed in `~/.pi/agent/.env` (same
`JEV_GUARD_*` names) — session env vars take priority.

### Jev response format (noul / score / choice)
Jev returns the value in a field **named by the question type**, not a flat
`probability`. jev-guard parses by type with a legacy fallback:

```json
{ "has_actionable_error": { "type": "noul", "noul": 0.02 } }
{ "risk_level":        { "type": "score", "score": 1.12 } }
{ "log_type":          { "type": "choice", "choice": "tests" } }
```

Unit-test mocks use this **real** form so the Jev layer can't silently die
behind a fake `probability` mock again.

### 7. 📊 Live TUI Telemetry
- Inspect live statistics in PI Mono anytime via:
  ```text
  /jev status
  ```
  Shows total logs checked, collapsed counts, blocked diffs, and API health.

---

## 🏗️ Architecture Pipeline

```
                     [Agent executes a shell command / test run]
                                        │
                                        ▼ (Output > 4000 chars)
                            ┌───────────────────────┐
                            │   pi.on("tool_result")│
                            └─────────────────���─────┘
                                        │
                                        ▼
                            ┌───────────────────────┐
                            │    Jev Decision API   │ ──► Latency: ~250ms
                            │ (typesafe/jev-1.13)   │ ──► Cost: $0.00003
                            └───────────────────────┘
                                        │
                         Is has_actionable_error < 0.20?
                                  /            \
                             YES /              \ NO (or error)
                                ▼                ▼
               [Prune middle → head+tail preview]  [Keep full verbatim log]
                                \                /
                                 ▼              ▼
                     [Commit to Session History (Tail)]
                                        │
                                        ▼
             ★ 100% Byte-Stable Prefix: PROMPT CACHE REMAINS HOT! ★
```

---

## 🚀 Quickstart & Configuration

### Prerequisites
- Node.js >= 18
- OpenRouter API key **OR** TypeSafe AI API key

### 1. API Key Setup
`jev-guard` automatically discovers your credentials in standard locations:
1. `TYPESAFE_API_KEY` (Direct API: `https://api.typesafe.ai/v1/decisions`)
2. `OPENROUTER_API_KEY` in environment, `~/.pi/agent/.env`, or `~/.librefang/secrets.env`

> **Note for OpenRouter users:** Ensure the provider `typesafe` is permitted in your [OpenRouter Privacy Settings](https://openrouter.ai/settings/privacy).

### 2. Installation into PI Mono
Clone or link into your PI Mono extensions directory:

```bash
git clone https://github.com/yelkhanyergali-sys/jev-guard.git ~/.pi/agent/extensions/jev-guard
```

Add to `~/.pi/agent/settings.json`:
```json
{
  "extensions": [
    "/home/admin/.pi/agent/extensions/jev-guard"
  ]
}
```

Reload extensions or restart your PI Mono session:
```bash
/reload
```

---

## 🧪 Testing

The repository includes a comprehensive, network-independent test suite with complete mock coverage:

```bash
node test/run.js
```

**Test Coverage:**
- ✅ English question/criteria structure calibration
- ✅ Calibrated `noul` probability evaluation (`p < 0.20` threshold)
- ✅ Long successful shell output → head/tail preview (`savedChars` accounting)
- ✅ Preserving outputs on test failures / exceptions (`isError` or `p >= 0.20`)
- ✅ Preserving short outputs (< maxLength chars) and single-line outputs
- ✅ Search tools (`grep`, `find`, `ls`, `ctx_*`) never pruned; shell tools always are
- ✅ Secret modification blocking via Jev (`modifies_secrets > 0.80`)
- ✅ Secret blocking via deterministic regex layer (no Jev call)
- ✅ Regex **false positives** stay allowed (`$API_KEY`, `os.environ[...]`,
  `config.password`, `sk-XXXX`, `sk-your-key-here`, bare hex hashes)
- ✅ `write` / `apply_patch` / `multi_file_edit` covered by diff guard
- ✅ `is_surgical` advisory reaches `ctx.ui.notify` (non-blocking) + `off` mode
- ✅ Advisory never crashes when `ctx.ui` is absent
- ✅ Runtime config overrides (thresholds + tool sets + `JEV_GUARD_LOG`)
- ✅ `extractDiff` returns null on empty diff (no JSON dump)
- ✅ `truncateState` keeps head + tail within the request cap
- ✅ Permitting safe, surgical code changes
- ✅ Fail-soft resilience (HTTP 404, 429, timeout, missing key)
- ✅ Test isolation: the suite runs against a temp `HOME` and never writes to
  the production log

---

## 📂 Project Structure

```
jev-guard/
├── index.js          # PI Mono extension entry point (hooks & /jev command)
├── package.json      # Package metadata and test scripts
├── LICENSE           # MIT License
├── README.md         # Comprehensive documentation
├── lib/
│   ├── client.js     # Decision API client (OpenRouter + Direct, fail-soft)
│   ├── config.js     # Runtime config via JEV_GUARD_* env vars
│   ├── pruner.js     # In-flight terminal pruning engine
│   └── diff_guard.js # Surgical diff & secret leak validator (regex + Jev)
└── test/
    └── run.js        # Autonomous unit test suite (48 tests)
```

---

## 📜 License

[MIT](LICENSE) © 2026 Yelkhan Yergaliev. Built with precision for autonomous AI engineering.
