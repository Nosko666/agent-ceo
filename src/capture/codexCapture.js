// src/capture/codexCapture.js
// ─────────────────────────────────────────────────────────
// Read Codex CLI's structured rollout JSONL files for
// clean response extraction (no terminal scraping).
//
// File: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl
// Completion signals (in priority order):
//   1. event_msg + payload.type:"task_complete" → payload.last_agent_message
//   2. event_msg + payload.type:"agent_message" + payload.phase:"final_answer" → payload.message
//   3. response_item + payload.role:"assistant" + payload.type:"message" → join content[].text
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { readChunk, splitCompleteLines, parseLine } = require('./jsonlReader');

class CodexCapture {
  constructor(codexHome) {
    this.codexHome = codexHome;
    this._currentRollout = null;
    this._sessionId = null;
  }

  /**
   * Find the latest rollout file in this agent's CODEX_HOME/sessions/
   */
  _findLatestRollout() {
    const sessionsDir = path.join(this.codexHome, 'sessions');
    if (!fs.existsSync(sessionsDir)) return null;

    let newest = null;
    let newestMtime = 0;

    const walk = (dir, depth) => {
      if (depth > 4) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath, depth + 1);
          } else if (entry.name.startsWith('rollout') && entry.name.endsWith('.jsonl')) {
            try {
              const stats = fs.statSync(fullPath);
              if (stats.mtimeMs > newestMtime) {
                newestMtime = stats.mtimeMs;
                newest = fullPath;
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    };

    walk(sessionsDir, 0);
    return newest;
  }

  /**
   * Extract session ID from the first line of a rollout file (session_meta).
   */
  _extractSessionId(rolloutPath) {
    try {
      const content = fs.readFileSync(rolloutPath, 'utf-8');
      const firstLine = content.split('\n')[0];
      const obj = JSON.parse(firstLine);
      if (obj.type === 'session_meta' && obj.payload && obj.payload.id) {
        return obj.payload.id;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Get the Codex session ID (for /revive support).
   */
  getSessionId() {
    if (this._sessionId) return this._sessionId;
    const rollout = this._currentRollout || this._findLatestRollout();
    if (rollout) {
      this._sessionId = this._extractSessionId(rollout);
    }
    return this._sessionId;
  }

  /**
   * Wait for Codex's response after the given byte offset.
   * Polls the rollout JSONL file for completion signals.
   *
   * @param {number} afterByteOffset - file position to start reading from
   * @param {object} options
   * @returns {Promise<{ text: string, newOffset: number, timedOut: boolean }>}
   */
  async waitForResponse(afterByteOffset, options = {}) {
    const { pollMs = 500, timeoutMs = 120000 } = options;

    let offset = afterByteOffset;
    let remainder = '';
    const startTime = Date.now();

    return new Promise((resolve) => {
      const poll = setInterval(() => {
        // Hard timeout
        if (Date.now() - startTime > timeoutMs) {
          clearInterval(poll);
          resolve({ text: '', newOffset: offset, timedOut: true });
          return;
        }

        // Find/track the rollout file (may switch if newer appears)
        const latestRollout = this._findLatestRollout();
        if (!latestRollout) return;

        if (this._currentRollout !== latestRollout) {
          const wasTracking = this._currentRollout !== null;
          this._currentRollout = latestRollout;
          this._sessionId = this._extractSessionId(latestRollout);
          if (wasTracking) {
            // Actually switched files — reset offset for the new file
            offset = 0;
            remainder = '';
          }
        }

        const data = readChunk(this._currentRollout, offset);
        if (!data) return;

        const { lines, remainder: newRemainder } = splitCompleteLines(data.chunk, remainder);
        remainder = newRemainder;
        offset = data.newSize;

        for (const line of lines) {
          const obj = parseLine(line);
          if (!obj) continue;

          // PRIMARY: task_complete with last_agent_message
          if (obj.type === 'event_msg' &&
              obj.payload &&
              obj.payload.type === 'task_complete' &&
              obj.payload.last_agent_message) {
            clearInterval(poll);
            resolve({
              text: obj.payload.last_agent_message.trim(),
              newOffset: offset,
              timedOut: false,
            });
            return;
          }

          // FALLBACK 1: agent_message with phase:"final_answer"
          if (obj.type === 'event_msg' &&
              obj.payload &&
              obj.payload.type === 'agent_message' &&
              obj.payload.phase === 'final_answer' &&
              obj.payload.message) {
            clearInterval(poll);
            resolve({
              text: obj.payload.message.trim(),
              newOffset: offset,
              timedOut: false,
            });
            return;
          }

          // FALLBACK 2: response_item with role:"assistant" type:"message"
          if (obj.type === 'response_item' &&
              obj.payload &&
              obj.payload.role === 'assistant' &&
              obj.payload.type === 'message' &&
              Array.isArray(obj.payload.content)) {
            const textParts = [];
            for (const block of obj.payload.content) {
              if (block.type === 'output_text' && block.text) {
                textParts.push(block.text);
              }
            }
            if (textParts.length > 0) {
              clearInterval(poll);
              resolve({
                text: textParts.join('\n').trim(),
                newOffset: offset,
                timedOut: false,
              });
              return;
            }
          }
        }
      }, pollMs);
    });
  }
}

module.exports = CodexCapture;
