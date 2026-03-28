# RemoteFlow Formatting Pipeline

Complete analysis of how the Discord bot processes, filters, and formats agent output for display in Discord threads.

## 1. COMPLETE FILE CONTENTS

### 1.1 src/stream-handler.js
See full file content (916 lines) in repository root.

**Key Classes:**
- `StreamHandler`: Manages real-time output streaming to Discord threads

**Core Responsibilities:**
- Buffers agent output and sends/edits Discord messages
- Converts Markdown tables to monospace code blocks (Discord doesn't render GFM tables)
- Handles permission prompts with interactive buttons
- Manages plan review UI (Plannotator integration)
- Archives threads after session completion
- Sends diff previews as inline code or file attachments
- Manages message rate limits and Discord's 5 edits/sec constraint

**Key Methods:**
- `start()`: Wires up event listeners for session lifecycle
- `flush()`: Sends accumulated output as Discord messages
- `scheduleUpdate()`: Debounced message flush (default 1500ms)
- `sendStatusMessage()`: Displays visual status indicators (⚙️ Processando, ✅ Concluído, ❌ Erro, etc.)

---

### 1.2 src/session-manager.js
See full file content (816 lines) in repository root.

**Key Classes:**
- `OpenCodeSession`: Represents one active session connected to an OpenCode server
- `SessionManager`: Registry and lifecycle manager for all active sessions

**Core Responsibilities:**
- Creates and tracks sessions per Discord thread
- Communicates with OpenCode server via HTTP/SSE
- Detects when agent is waiting for user input
- Manages message queue for async input
- Handles permission requests
- Detects plan completion for plan agent

**CRITICAL: Text vs Reasoning Output Filtering**
```javascript
// Line 349-351 in session-manager.js
case 'message.part.delta': {
  // Só processar deltas de texto (não reasoning)
  if (props.field !== 'text') return;  // <-- FILTERS OUT REASONING/THINKING
```

**Agent Output Filtering:**
- SSE events from OpenCode include `message.part.delta` with `props.field` property
- Only events where `props.field === 'text'` are processed
- Events where `props.field === 'reasoning'` are **silently dropped** (not sent to Discord)
- This prevents internal agent thinking/reasoning from cluttering the user-facing output

**Input Detection:**
```javascript
// Lines 20-48: Heuristic input pattern detection
const INPUT_PATTERNS = [
  /\?\s*$/m,            // Line ends with ?
  /\(y\/n\)/i,          // (y/n)
  /\(s\/n\)/i,          // (s/n) — sim/não PT-BR
  // ... plus 10 more patterns
];

function isWaitingForInput(text) {
  const tail = text.slice(-500);
  return INPUT_PATTERNS.some((p) => p.test(tail));
}
```

---

### 1.3 src/utils.js - ANSI Stripping Logic
```javascript
// Complete ANSI stripping pipeline
import stripAnsiLib from 'strip-ansi';

// Caracteres de controle a remover (exceto \n \r \t)
// [\x00-\x08]: NUL–BS  [\x0B-\x0C]: VT, FF  [\x0E-\x1F]: SO–US  [\x7F]: DEL
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripAnsi(str) {
  if (!str) return '';
  return stripAnsiLib(str).replace(CONTROL_CHARS_RE, '');
}
```

**Pipeline:**
1. Input: Raw delta from OpenCode SSE (may contain ANSI codes and control chars)
2. `stripAnsiLib()`: Removes ANSI escape sequences (colors, formatting)
3. Regex replace: Removes remaining control characters
4. Output: Clean text for Discord

**Used in:**
- `session-manager.js` line 355: `const clean = stripAnsi(delta);`
- All deltas are cleaned before being emitted as `'output'` event

---

### 1.4 src/index.js - Message Routing (Partial, Lines 1-278)

**Key Features:**
- Slash command registration and execution
- Message routing: inline messages in threads → OpenCode stdin
- Passthrough mode: toggle to enable/disable automatic message forwarding
- Message queue: if agent is running, queues input; if idle, sends immediately
- Special commands: `/stop`, `/status`

**Inline Message Flow (lines 142-227):**
```javascript
// Line 143+: messageCreate event handler
client.on('messageCreate', async (message) => {
  // 1. Ignore bot messages
  // 2. Only process thread messages
  // 3. Check user authorization
  // 4. Find associated session
  // 5. Check passthrough enabled
  // 6. Queue message for send
  // 7. Notify user of queue position or send confirmation emoji ⚙️
});
```

---

### 1.5 src/config.js - Constants & Validation

**Discord/Streaming Constants:**
```javascript
export const DISCORD_MSG_LIMIT = 1900;  // Max chars per message
export const STREAM_UPDATE_INTERVAL = 1500;  // Flush debounce (ms)
export const PERMISSION_TIMEOUT_MS = 60000;  // Auto-approve timeout
export const THREAD_ARCHIVE_DELAY_MS = 5000;  // Delay before archiving
```

**Table of all ~40+ environment variables** documented with defaults.

---

### 1.6 src/sse-parser.js - SSE Event Parsing

**Simple SSE protocol parser:**
- Reads `Server-Sent Events` from ReadableStream
- Dispatches events with `type`, `data`, `id` fields
- Handles multi-line data and field parsing
- Used by OpenCode client to receive streaming deltas

---

## 2. COMPLETE TEXT PROCESSING PIPELINE

### 2.1 Raw Agent Output Flow

```
OpenCode Server
    ↓
SSE Event: { type: 'message.part.delta', data: { properties: { field: 'text'|'reasoning', delta: '...' } } }
    ↓
session-manager.js handleSSEEvent() [Line 341]
    ├─ Filter by field: only 'text' allowed [Line 351]
    ├─ stripAnsi(delta) [Line 355]
    ├─ Accumulate to outputBuffer, pendingOutput, _recentOutput [Lines 356-358]
    └─ emit('output', clean) [Line 374]
    ↓
stream-handler.js 'output' listener [Line 51]
    ├─ Append to currentContent [Line 53]
    └─ scheduleUpdate() [Line 54]
    ↓
[Debounce 1500ms]
    ↓
stream-handler.js flush() [Line 288]
    ├─ Process complete lines only [Lines 291-296]
    ├─ Combine with pending table lines [Lines 299-301]
    ├─ convertMarkdownTables() [Line 304]
    │  └─ Detect GFM tables and convert to monospace code blocks
    ├─ splitIntoChunks() [Line 311]
    │  └─ Split into chunks respecting 1900 char limit
    └─ For each chunk:
       ├─ If current message has space, edit it [Line 329]
       └─ Otherwise, create new message [Line 345]
```

### 2.2 ANSI & Control Character Removal

**Occurs at:** `session-manager.js` line 355

```javascript
const clean = stripAnsi(delta);
```

**Removes:**
1. **ANSI escape sequences** (colors, formatting, cursor commands)
   - Examples: `\x1b[31m` (red), `\x1b[1m` (bold), `\x1b[2K` (clear line)
2. **Control characters** (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F)
   - Preserves: `\n` (0x0A), `\r` (0x0D), `\t` (0x09)

**Why:**
- Discord doesn't support ANSI codes
- Control chars can corrupt text rendering or exploit format parsing

---

### 2.3 Table Formatting Pipeline

**Location:** `stream-handler.js` lines 807-853 (`convertMarkdownTables()`)

**Problem:** Discord doesn't render GFM (GitHub Flavored Markdown) tables

**Solution:** Convert Markdown tables to monospace code blocks

**Table Detection Pattern:**
```
| Header 1 | Header 2 |
|----------|----------|
| Data 1   | Data 2   |
```

**Conversion:**
```javascript
function convertMarkdownTables(text, isLastChunk = false) {
  // 1. Split input by lines
  // 2. Find table patterns (header + separator + data rows)
  // 3. Strip inline Markdown formatting (**bold**, *italic*, `code`)
  // 4. Calculate column widths (max width per column)
  // 5. Format as monospace code block with box-drawing chars (─)
  // 6. Return pending lines that might be incomplete table
}
```

**Output Example:**
```
```` 
Header 1  Header 2
─────────  ─────────
Data 1    Data 2
````
```

**Buffering Behavior:**
- Incomplete tables at end of chunk are held as pending
- Combined with next chunk's output before conversion
- Ensures table detection doesn't break across flush boundaries

---

### 2.4 Message Chunking

**Location:** `stream-handler.js` lines 861-879 (`splitIntoChunks()`)

**Rules:**
- Max 1900 characters per Discord message (default, configurable)
- Breaks at newlines when possible
- Avoids splitting in middle of line

**Logic:**
```javascript
function splitIntoChunks(t
