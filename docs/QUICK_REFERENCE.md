# Quick Reference: RemoteFlow Text Processing

## File Locations

| File | Purpose | Key Location |
|------|---------|--------------|
| `src/stream-handler.js` | Discord message management | 916 lines |
| `src/session-manager.js` | SSE event handling & filtering | 816 lines |
| `src/utils.js` | ANSI stripping | 50 lines |
| `src/config.js` | Constants & validation | 143 lines |
| `src/sse-parser.js` | SSE protocol parser | 98 lines |

## Critical Filtering

### Agent Output Filtering (session-manager.js:351)
```javascript
case 'message.part.delta': {
  if (props.field !== 'text') return;  // EXCLUDES reasoning/thinking
  const clean = stripAnsi(delta);      // REMOVES ANSI codes
  // ... emit to Discord
}
```

**Result:**
- ✅ `field: 'text'` → shown on Discord
- ❌ `field: 'reasoning'` → silently dropped

## ANSI Stripping (utils.js:31-34)

```javascript
export function stripAnsi(str) {
  if (!str) return '';
  return stripAnsiLib(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}
```

**Removes:**
- ANSI escape sequences (\x1b[...m for colors)
- Control characters (except \n, \r, \t)

## Markdown Table Conversion (stream-handler.js:807-853)

**Input:**
```
| Col1 | Col2 |
|------|------|
| Data | Data |
```

**Output:**
```
```
Col1  Col2
────  ────
Data  Data
```
```

**Why:** Discord doesn't render GFM tables

## Message Chunking (stream-handler.js:861-879)

- Max 1900 chars/message (configurable)
- Breaks at newlines when possible
- Respects Discord's 5 edits/sec rate limit via 1500ms debounce

## Complete Flow

```
OpenCode SSE event
  ↓
session-manager: filter (field=='text') + stripAnsi
  ↓
emit 'output' event
  ↓
stream-handler: append to buffer
  ↓
[1500ms debounce]
  ↓
flush():
  ├─ convertMarkdownTables()
  ├─ splitIntoChunks()
  └─ send/edit Discord messages
```

## Status Messages

- `running`: "⚙️ **Processando...**"
- `finished`: "✅ **Sessão concluída**"
- `error`: "❌ **Sessão encerrada com erro**"
- `waiting_input`: "💬 **Aguardando sua resposta...**"

## Input Detection Patterns (session-manager.js:21-36)

Agent is waiting for input if output ends with:
- `?` (question mark)
- `(y/n)`, `(s/n)`, `(yes/no)`, `(sim/não)`
- `escolha:`, `selecione:`, `digite:`, `informe:`
- `press enter`, `pressione enter`
- `>` (prompt)
- Numbered options: `1)` or `1.`

## Message Queuing

**If agent is running:**
```
User message → Queue → Reply: "📮 Posição X na fila"
```

**If agent is idle/waiting:**
```
User message → Send immediately → Reaction: ⚙️
```

## Key Constants

| Constant | Value | Tunable |
|----------|-------|---------|
| Message limit | 1900 chars | `DISCORD_MSG_LIMIT` |
| Flush interval | 1500 ms | `STREAM_UPDATE_INTERVAL` |
| Permission timeout | 60 sec | `PERMISSION_TIMEOUT_MS` |
| Archive delay | 5 sec | `THREAD_ARCHIVE_DELAY_MS` |
| Session timeout | 30 min | `SESSION_TIMEOUT_MS` |

## Event Types

| Event | Source | Handler |
|-------|--------|---------|
| `output` | SSE delta | Append to buffer |
| `status` | Session state | Send status message |
| `permission` | Agent request | Show button UI |
| `question` | Agent inquiry | Display Q&A |
| `diff` | File changes | Send preview |
| `close` | Session end | Archive thread |

## Testing

Reasoning vs text output test (session-manager.test.js:596):
```javascript
// This is DROPPED
{ type: 'message.part.delta', data: { properties: { field: 'reasoning', delta: '...' } } }

// This is SHOWN
{ type: 'message.part.delta', data: { properties: { field: 'text', delta: '...' } } }
```

---

**For detailed analysis, see `FORMATTING_PIPELINE.md`**
