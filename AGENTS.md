# AGENTS.md — RemoteFlow

Coding guidelines for AI agents and contributors working in this repository.

---

## Project Overview

A Discord bot that bridges Discord threads to local `opencode` CLI processes on Windows.
Built with **plain JavaScript (ES Modules)**, targeting **Node.js ≥ 20.0.0**. No build step,
no compilation — the source in `src/` runs directly.

**Key files:**
| File | Purpose |
|---|---|
| `src/index.js` | Entry point: Discord client, event wiring, graceful shutdown |
| `src/commands.js` | Slash command definitions and handlers |
| `src/session-manager.js` | Session and `opencode` process lifecycle |
| `src/stream-handler.js` | Real-time output streaming to Discord threads |
| `.env.example` | Documents all required/optional environment variables |
| `specs/0001/SPEC.md` | Full feature specification with requirement IDs (RF-xx / RNF-xx) |

---

## Commands

### Run / Dev

```bash
npm start          # Production — node src/index.js
npm run dev        # Development — node --watch src/index.js (auto-restart on save)
```

### No build step

There is no `build`, `compile`, or `bundle` command. Files are executed directly by Node.

### Tests

No test suite is configured yet. When tests are added, the recommended setup is:

```bash
npm test               # Run all tests
npm test -- path/to/file.test.js          # Run a single test file
npm test -- --testNamePattern "my test"   # Run tests matching a name (Jest)
```

Place test files in `tests/` mirroring the `src/` structure (e.g., `tests/session-manager.test.js`).
Prefer **Jest** or **Vitest** (ESM-native) when setting up the test framework.

### Lint / Format

No linter or formatter is configured. If added, the expected commands would be:

```bash
npm run lint           # ESLint
npm run format         # Prettier
```

---

## Environment Setup

Copy `.env.example` to `.env` and fill in required values before running.

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | — | Bot token from Discord Developer Portal |
| `DISCORD_GUILD_ID` | ✅ | — | Server (guild) ID for slash command registration |
| `PROJECTS_BASE_PATH` | ✅ | — | Base directory for `opencode` projects |
| `OPENCODE_BIN` | | `opencode` | Path or name of the `opencode` binary |
| `ALLOWED_USER_IDS` | | (all) | Comma-separated Discord user IDs allowed to run commands |
| `DISCORD_MSG_LIMIT` | | `1900` | Max characters per Discord message |
| `STREAM_UPDATE_INTERVAL` | | `1500` | Milliseconds between stream buffer flushes |

---

## Code Style

### Language

- **JavaScript only** — no TypeScript. Keep it that way unless the project explicitly migrates.
- Use **ES Module** syntax (`import`/`export`). Never use `require()`.
- Always include `.js` extensions in local import paths: `import { Foo } from './foo.js'`

### Imports

```js
// Static imports at the top of the file
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { SessionManager } from './session-manager.js';

// Dynamic imports only for conditional or lazy loading inside functions
const { StreamHandler } = await import('./stream-handler.js');
```

### Naming

| Convention | Used for |
|---|---|
| `camelCase` | Functions, variables, method names |
| `PascalCase` | Classes (`OpenCodeSession`, `SessionManager`) |
| `UPPER_SNAKE_CASE` | Environment variables, module-level constants |
| `is` / `has` prefix | Boolean-returning methods (`isWaitingForInput()`) |

### File Organization

Use section dividers to organize files longer than ~150 lines:

```js
// ─── Section Title ────────────────────────────────────────────────────────────
```

Order within a file: imports → constants → class/function exports → internal utilities.

### Comments & Logging

- Inline comments and JSDoc are written in **Portuguese (PT-BR)** — match existing style.
- User-facing bot messages are also in **Portuguese (PT-BR)**.
- Log prefixes use the component name in brackets: `console.error('[SessionManager] Erro:', err)`
- Use emoji in log/status messages for visual scanning: `🤖`, `✅`, `❌`, `⚙️`, `💬`

### JSDoc

Add JSDoc for all exported classes and functions:

```js
/**
 * Cria uma nova sessão OpenCode para o projeto especificado.
 * @param {string} projectPath - Caminho absoluto do projeto
 * @param {string} threadId - ID da thread Discord associada
 * @returns {OpenCodeSession}
 */
export function createSession(projectPath, threadId) { … }
```

---

## Slash Command Conventions

### Command Names — English Only

All slash command names, subcommand names, and option names **must be in English**.
This rule is absolute — no exceptions.

✅ Correct:
```
/sessions
/stop
/projects
/history
/command
/queue view
/queue clear
```

❌ Wrong:
```
/sessoes
/parar
/projetos
/historico
/comando
/fila ver
/fila limpar
```

**Why:** Discord slash commands are user-facing identifiers. English names ensure
consistency, discoverability, and alignment with Discord's global ecosystem.

**Where this is enforced:**
- `commandDefinitions` in `src/commands.js` — all `.setName()` calls use English
- Tests in `tests/commands.test.js` — test command names match source exactly

**When adding a new command:**
- Use English for command name, subcommand names, and all option names
- Descriptions (`.setDescription()`) may be in Portuguese (PT-BR) for clarity
- User-facing reply messages remain in Portuguese (PT-BR)

---

## Error Handling

1. **Validate env vars at startup** — call `process.exit(1)` early if required vars are missing.
2. **Try-catch Discord API calls** — log the error and fall back silently; never crash on a Discord
   API failure.
3. **EventEmitter for session lifecycle** — sessions emit `output`, `status`, `close`, `error`
   events; consumers subscribe rather than polling.
4. **Global safety net** — `uncaughtException` and `unhandledRejection` handlers in `index.js`
   log the error without crashing. Do not remove them.
5. **Graceful shutdown** — `SIGINT`/`SIGTERM` handlers kill active sessions before exit.

---

## Architecture Constraints

- **One thread per session** — never reuse a Discord thread for a different `opencode` process.
- **Rate-limit awareness** — the `StreamHandler` batches output at `STREAM_UPDATE_INTERVAL` (default
  1500 ms) to stay within Discord's 5 edits/sec limit. Do not bypass this.
- **No PTY** — process I/O uses pipes (`child_process.spawn`), not a pseudo-terminal. This is
  intentional for Windows compatibility.
- **ANSI stripping** — always strip ANSI escape codes before sending output to Discord.
- **Session retention** — closed sessions are retained for 10 minutes for status queries, then GC'd.
- **Auxiliary documentation** — all supplementary `.md` files (analysis documents, references, pipeline docs, research notes, etc.) must reside in `docs/`. The repository root should only contain `README.md`, `CHANGELOG.md`, `AGENTS.md`, and other mandatory top-level files.

---

## Validation Requirements

**Toda modificação de código deve passar pela validação antes de ser submetida.**

### Obrigatório antes de cada commit

1. **Executar os testes:**
   ```bash
   npm run test:ci
   ```
   Todos os testes devem passar. Nenhuma falha é aceitável.

2. **Verificar que o servidor inicia sem erros:**
   ```bash
   node --check src/index.js
   ```
   O arquivo de entrada deve passar na verificação de sintaxe sem erros.

### Regras

- **Nunca faça commit com testes falhando.** Se um teste quebrar com sua mudança, corrija o código ou o teste antes de commitar.
- **Novos comportamentos exigem novos testes.** Todo novo comando, evento ou função exportada deve ter cobertura de teste correspondente em `tests/`.
- **Testes devem refletir a interface real.** Nomes de comandos, eventos e métodos nos testes devem estar em sincronia com o código-fonte.

---

## Commit Style

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add /reload command for restarting a session
fix: prevent duplicate thread creation on rapid clicks
docs: update .env.example with STREAM_UPDATE_INTERVAL
refactor: extract ANSI stripping into utils.js
test: add unit tests for session-manager lifecycle
```

Reference spec requirement IDs where applicable: `feat(RF-04): implement input routing to stdin`

---

## Changelog Requirements

**Every code modification must include a CHANGELOG.md update before being committed.**

### Required for every commit that changes behavior

1. **Update CHANGELOG.md** — add an entry to the appropriate version block (or create a new version block if warranted):
   - Use the format `## [X.Y.Z] — YYYY-MM-DD`
   - Group changes under: `### ✨ Added`, `### 🔧 Changed`, `### 🐛 Fixed`, `### ♻️ Refactored`, `### 🔒 Security`
   - Write entries in **Portuguese (PT-BR)**
   - Reference spec IDs where applicable (e.g., RF-04)
   - Follow [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/) conventions

### Rules

- **Never commit without a CHANGELOG entry.** If your change adds, removes, or modifies behavior, document it.
- **Dependency bumps** go under a `### 🔧 Changed` entry (e.g., "Atualização de dependência: `picomatch` 4.0.3 → 4.0.4").
- **Test-only or docs-only changes** may use a `### 📝 Docs` or `### 🧪 Tests` entry.
- **Patch fixes** (bug corrections without new features) increment the patch version (e.g., 1.4.0 → 1.4.1).
- **New features** increment the minor version (e.g., 1.4.0 → 1.5.0).
- **Breaking changes** increment the major version (e.g., 1.x.x → 2.0.0).

---

## Windows Notes

- The service installer uses **NSSM** (`scripts/install-service.ps1`). Run it as Administrator.
- Path separators in `.env` values should use backslashes or forward slashes — Node.js handles both.
- The bot is designed to run on the **same Windows machine** as the `opencode` binary.
