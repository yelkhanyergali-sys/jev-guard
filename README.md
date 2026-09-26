# 🛡️ jev-guard

> **Ultra-fast In-Flight Terminal Pruning and Surgical Diff Guard for [PI Coding Agent](https://github.com/yelkhanyergali-sys/pi-mono), powered by Jev (TypeSafe AI) — the world's first System One decision model.**

[![Tests](https://img.shields.io/badge/tests-20%20passed-brightgreen.svg)](test/run.js)
[![Model](https://img.shields.io/badge/Jev-typesafe%2Fjev--1.13-orange.svg)](https://typesafe.ai)
[![Node](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Prompt Cache](https://img.shields.io/badge/Prompt%20Cache-100%25%20Safe-purple.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## ⚡ The Problem: Coding Agent Context Bloat & Cache Destruction

Modern AI coding agents (Claude Code, Cursor, PI Mono) suffer from two fundamental problems during heavy development sessions:

1. **Terminal Log Bloat:** Running `cargo test`, `pytest`, or `npm run build` dumps 500–1,000 lines of raw compiler/test logs into the conversation context. After 15 runs, **20,000+ tokens of pure boilerplate** pollute the context window, causing models to forget initial project instructions (*Lost in the Middle* effect).
2. **The Prompt Cache Trap:** Traditional compaction via LLMs summarizes past history. But retroactively rewriting older messages **breaks the frozen byte-prefix**, destroying 80–99% prompt cache hit rates and forcing expensive full-token re-billing.
3. **Accidental Credential Modifications (Drive-By Edits):** Agents occasionally hallucinate or over-edit, overwriting `.env` files, API keys, or certificates before human review.

---

## 💡 The Solution: Jev (System One Decision Model)

Created by Diogo Almeida (ex-OpenAI researcher and co-author of RLHF / InstructGPT), **Jev by TypeSafe AI** is fundamentally **NOT a traditional LLM**:
- 🚫 **No text generation:** Jev cannot hallucinate prose, break JSON quotes, or write conversational filler.
- ⚡ **Pure Decision Engine:** Given an application `state` (terminal log, diff, code up to 32k tokens) and typed `questions`, Jev returns calibrated mathematical probabilities (`noul`), categorical choices (`choice`), or ordinal ratings (`score`).
- ⏱️ **Sub-250ms Latency:** Forward-pass parallel sampling evaluates multiple questions in a single round-trip.
- 💸 **Insane Economics:** **$0.042 per 1M input tokens**, with **$0.00 output token billing** (output is free!).

---

## ✨ Key Features ("Все плюшки")

### 1. 🧹 In-Flight Terminal Pruning (98.5% Token Reduction)
- Intercepts `bash` and `ctx_shell` commands at the `tool_result` event boundary.
- If a command succeeds (`exit code 0`) and the output exceeds 800 characters, Jev evaluates:
  ```json
  "has_actionable_error": { "type": "noul", "instructions": "Does this terminal output contain an error or failure requiring fixing?" }
  ```
- If `has_actionable_error < 0.20`:
  The 1,000-line output is collapsed into a single lightweight token line:
  ```text
  [Output collapsed by jev-guard: 45 lines of successful output, exit code 0]
  ```
- **Real-world saving:** A 1,000-token test suite dump shrinks to **15 tokens**.

### 2. 🔒 100% Byte-Stable Prompt Cache Preservation
- **Why other pruners fail:** Modifying past history breaks the prefix cache.
- **How jev-guard succeeds:** Pruning occurs **in-flight at the very tail of the turn** *before* the message is appended to the session history array. The preceding conversation prefix remains 100% byte-for-byte identical. **Your 90%+ prompt cache hit rate never drops!**

### 3. 🚨 Surgical Diff & Secret Guard
- Intercepts file modification tools (`edit`, `ctx_patch`, `multi-edit`) at the `tool_call` hook.
- Evaluates `modifies_secrets` (`.env` credentials, private keys, passwords).
- If `modifies_secrets > 0.80`, the operation is **immediately blocked before touching the disk**:
  ```text
  BLOCKED by jev-guard: attempt to modify secrets or credentials.
  ```

### 4. 🦺 Fail-Soft Architecture (Zero Workflow Interruption)
- Strict **2.0-second timeout** (`AbortSignal.timeout(2000)`).
- If OpenRouter, TypeSafe API, or the network encounters an error (HTTP 404, 429, timeout), `jev-guard` **never crashes or blocks the agent**. It logs a silent warning and passes the original output through untouched.

### 5. 📊 Live TUI Telemetry
- Inspect live statistics in PI Mono anytime via:
  ```text
  /jev status
  ```
  Shows total logs checked, collapsed counts, blocked diffs, and API health.

---

## 🏗️ Architecture Pipeline

```
                     [Agent executes bash command / test run]
                                        │
                                        ▼ (Output > 800 chars)
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
               [Collapse to 1 line]          [Keep full verbatim log]
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
- ✅ Long successful bash output collapsing
- ✅ Preserving outputs on test failures / exceptions (`exit != 0` or `p >= 0.20`)
- ✅ Preserving short outputs (<800 chars)
- ✅ Secret modification blocking (`modifies_secrets > 0.80`)
- ✅ Permitting safe, surgical code changes
- ✅ Fail-soft resilience (HTTP 404, 429, timeout, missing key)

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
│   ├── pruner.js     # In-flight terminal pruning engine
│   └── diff_guard.js # Surgical diff & secret leak validator
└── test/
    └── run.js        # Autonomous unit test suite (20 tests)
```

---

## 📜 License

[MIT](LICENSE) © 2026 Yelkhan Yergaliev. Built with precision for autonomous AI engineering.
