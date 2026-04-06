// src/capture/claudeCapture.js
// ─────────────────────────────────────────────────────────
// Read Claude Code's structured JSONL session files for
// clean response extraction (no terminal scraping).
//
// File: ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
// Final answer: type:"assistant" + message.role:"assistant"
//   + message.stop_reason:"end_turn"
//   → join message.content[].text where type:"text"
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const { readChunk, splitCompleteLines, parseLine } = require('./jsonlReader');

class ClaudeCapture {
  constructor(jsonlPath) {
    this.jsonlPath = jsonlPath;
  }

  /**
   * Wait for Claude's final response after the given byte offset.
   * Polls the JSONL file for new lines.
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

        // File may not exist yet (Claude creates it lazily)
        if (!fs.existsSync(this.jsonlPath)) return;

        const data = readChunk(this.jsonlPath, offset);
        if (!data) return; // no new bytes

        const { lines, remainder: newRemainder } = splitCompleteLines(data.chunk, remainder);
        remainder = newRemainder;
        offset = data.newSize;

        for (const line of lines) {
          const obj = parseLine(line);
          if (!obj) continue;

          // Look for the final assistant response
          if (obj.type === 'assistant' &&
              obj.message &&
              obj.message.role === 'assistant' &&
              obj.message.stop_reason === 'end_turn') {

            // Extract only text blocks (ignore thinking, tool_use, progress)
            const textParts = [];
            if (Array.isArray(obj.message.content)) {
              for (const block of obj.message.content) {
                if (block.type === 'text' && block.text) {
                  textParts.push(block.text);
                }
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

module.exports = ClaudeCapture;
