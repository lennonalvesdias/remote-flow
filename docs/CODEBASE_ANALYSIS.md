# RemoteFlow — Codebase Analysis

## Overview

This document provides a comprehensive analysis of how the RemoteFlow processes output from the opencode CLI and sends it to Discord, with special focus on text formatting, message chunking, and streaming.

**Project Structure:**
- **Language:** Plain JavaScript (ES Modules)
- **Runtime:** Node.js ≥ 20.0.0
- **No build step** — files execute directly
- **Main components:** `session-manager.js`, `stream-handler.js`, `commands.js`, `index.js`

---

## 1. Output Processing Pipeline

### 1.1 High-Level Flow

```
OpenCode Process stdout/stderr
         ↓
    Session event emission ('output' event)
         ↓
    StreamHandler.currentContent accumulation
         ↓
    Debounce timer (STREAM_UPDATE_INTERVAL = 1500ms)
         ↓
    flush() → splitIntoChunks()
         ↓
    Discord API: send or edit messages
```

### 1.2 Data Flow Through Key Components

#### OpenCodeSession (session-manager.js)

**Where output enters the system:**
- Lines 180-206: `handleSSEEvent()` processes `message.part.delta` events
- Output is stripped of ANSI codes via `stripAnsi(delta)` (line 186)
- Three buffers accumulate the clean text:
  - `outputBuffer` — complete session history (capped at MAX_BUFFER = 512KB)
  - `pendingOutput` — output since last flush
  - `_recentOutput` — last 1000-2000 chars for input detection

**Key code:**
```javascript
case 'message.part.delta': {
  // Only process text fields (not reasoning)
  if (props.field !== 'text') return;
  const delta = props.delta ?? '';
  if (!delta) return;

  const clean = stripAnsi(delta);  // ANSI codes removed here
  this.outputBuffer += clean;
  this.pendingOutput += clean;
  this._recentOutput += clean;
  
  // Cap buffers to prevent memory explosion
  if (this._recentOutput.length > 2000) {
    this._recentOutput = this._recentOutput.slice(-1000);
  }
  if (this.outputBuffer.length > MAX_BUFFER) {
    this.outputBuffer = this.outputBuffer.slice(-MAX_BUFFER);
  }

  this.emit('output', clean);  // Forward to StreamHandler
}
```

#### StreamHandler (stream-handler.js)

**Core streaming logic:**

1. **Line 44-48:** Listens to 'output' event from session
   ```javascript
   this.session.on('output', (chunk) => {
     this.hasOutput = true;
     this.currentContent += chunk;  // Accumulate text
     this.scheduleUpdate();          // Queue debounced flush
   });
   ```

2. **Line 219-225:** Schedules debounced update
   ```javascript
   scheduleUpdate() {
     if (this.updateTimer) return;
     this.updateTimer = setTimeout(async () => {
       this.updateTimer = null;
       await this.flush();
     }, UPDATE_INTERVAL);  // Default 1500ms
   }
   ```

3. **Line 230-272:** The `flush()` method — core message sending logic
   - Splits accumulated content into chunks respecting DISCORD_MSG_LIMIT (default 1900)
   - For each chunk:
     - If the current Discord message has room AND session is running/waiting_input:
       - **Edit** the existing message (visual streaming effect)
     - Else:
       - **Create** a new message
   
   **Key code:**
   ```javascript
   async flush() {
     if (!this.currentContent.trim()) return;

     const content = this.currentContent;
     this.currentContent = '';

     // Divide into chunks respecting Discord limit
     const chunks = splitIntoChunks(content, MSG_LIMIT);
     debug('StreamHandler', `🚿 flush iniciado | conteúdo=${content.length} chars | chunks a enviar=${chunks.length}`);

     for (const chunk of chunks) {
       if (!chunk.trim()) continue;

       try {
         // Try to edit current message if it has room
         if (
           this.currentMessage &&
           this.session &&
           (this.session.status === 'running' || this.session.status === 'waiting_input') &&
           this.currentMessageLength + chunk.length < MSG_LIMIT
         ) {
           const newContent = mergeContent(this.currentRawContent, chunk);

           if (newContent.length <= MSG_LIMIT) {
             debug('StreamHandler', `✏️  editando mensagem existente (${newContent.length} chars)`);
             await this.currentMessage.edit(newContent);
             this.currentRawContent = newContent;
             this.currentMessageLength = newContent.length;
             continue;
           }
         }

         // Create new message
         debug('StreamHandler', `📨 criando nova mensagem (${chunk.length} chars)`);
         this.currentMessage = await this.thread.send(chunk);
         this.currentRawContent = chunk;
         this.currentMessageLength = chunk.length;
       } catch (err) {
         console.error('[StreamHandler] Erro ao enviar mensagem:', err.message);
       }
     }
   }
   ```

---

## 2. Text Formatting & Message Chunking

### 2.1 Message Chunking Algorithm

**Function:** `splitIntoChunks(text, limit)` — Lines 361-380 in stream-handler.js

**Strategy:**
- Respects Discord's 2000 character limit
- Default configured limit: 1900 chars (config.js, line 16)
- **Smart line-breaking:** Attempts to split at the nearest newline before the limit
- If no newline found, splits at hard limit

**Code:**
```javascript
function splitIntoChunks(text, limit) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to break at newline
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;  // Fall back to hard limit

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();  // Remove leading whitespace
  }

  return chunks;
}
```

**Example:**
- Input: 5000 chars of text
- Output: Multiple chunks of ≤1900 chars each, split on newlines where possible

### 2.2 Current Text Formatting Approach

**Key limitation:** Currently, NO special formatting is applied to output

- Output is displayed **as-is** after ANSI stripping
- All output is treated as raw terminal text
- No table detection, markdown conversion, or special formatting
- No code block wrapping around regular output

**ANSI Stripping:**
- `stripAnsi()` function in utils.js (lines 31-34)
- Uses `strip-ansi` library for safe ANSI removal
- Also removes control characters (0x00-0x08, 0x0E-0x1F, 0x7F)

```javascript
export function stripAnsi(str) {
  if (!str) return '';
  return stripAnsiLib(str).replace(CONTROL_CHARS_RE, '');
}
```

### 2.3 Special Formatting — Only for Diffs

**Diff Preview (Lines 144-167):**
- Small diffs (≤1500 chars): Inline with syntax highlighting
- Large diffs: Sent as `.diff` file attachment

```javascript
async _sendDiffPreview(filePath, content) {
  const ext = filePath.split('.').pop() || '';
  const fileName = filePath.split(/[\/]/).pop();

  if (content.length <= DIFF_INLINE_LIMIT) {
    // Inline: code block with syntax highlighting
    const lang = getDiffLanguage(ext);
    const formatted = `📝 **${fileName}**\n\`\`\`${lang}\n${content}\n\`\`\``;

    if (formatted.length <= MSG_LIMIT) {
      await this.thread.send(formatted);
    } else {
      // Falls back to file if too large
      await this._sendDiffAsFile(fileName, content);
    }
  } else {
    // Send as .diff attachment
    await this._sendDiffAsFile(fileName, content);
  }
}
```

---

## 3. Input Detection (Waiting for User Response)

### 3.1 Pattern-Based Detection

**Location:** session-manager.js, lines 18-46

**Patterns that indicate agent is waiting for input:**
```javascript
const INPUT_PATTERNS = [
  /\?\s*$/m,            // Line ends with ?
  /\(y\/n\)/i,          // (y/n)
  /\(s\/n\)/i,          // (s/n) — yes/no in PT-BR
  /\(yes\/no\)/i,       // (yes/no)
  /\(sim\/não\)/i,      // (sim/não)
  /escolha:/i,          // choice:
  /selecione:/i,        // select:
  /confirma(?!r)/i,     // confirm (but not "confirmar")
  /digite:/i,           // type:
  /informe:/i,          // inform:
  /press\s+enter/i,     // press enter
  /pressione\s+enter/i, // pressione enter
  /^\s*>\s*$/m,         // Prompt > alone on line
  /^\s*\d+[).]\s+\S/m,  // Numbered options: "1) item
