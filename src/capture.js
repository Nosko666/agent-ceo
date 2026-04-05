// src/capture.js
// ─────────────────────────────────────────────────────────
// Watches agent log files for response completion
// Uses byte-offset tracking + prompt detection + silence timeout
// ─────────────────────────────────────────────────────────
const fs = require('fs');

const DEFAULT_POLL_MS = 500;
const DEFAULT_SILENCE_MS = 5000;  // 5s silence after last byte = response done
const DEFAULT_TIMEOUT_MS = 120000;

class ResponseCapture {
  constructor(paneManager) {
    this.paneManager = paneManager;
  }

  /**
   * Wait for an agent's response to complete.
   * Polls the log file for new content. Completes when:
   *   1. Provider prompt pattern detected (fast path)
   *   2. No new bytes for silenceMs (silence detection)
   *   3. Hard timeout (fallback)
   *
   * @param {string} agentName
   * @param {object} options
   * @returns {Promise<{ text: string, partial: boolean, timedOut: boolean }>}
   */
  waitForResponse(agentName, options = {}) {
    const {
      pollMs = DEFAULT_POLL_MS,
      silenceMs = DEFAULT_SILENCE_MS,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;

    const pane = this.paneManager.panes.get(agentName);
    if (!pane) {
      return Promise.resolve({ text: '', partial: false, timedOut: false });
    }

    const provider = pane.provider;

    return new Promise((resolve) => {
      let lastSize = 0;          // track actual file size to detect real growth
      let lastGrowthTime = null; // when the file last grew (not just peeked)
      let settled = false;
      const startTime = Date.now();

      const poll = setInterval(() => {
        if (settled) return;

        // Check hard timeout
        if (Date.now() - startTime > timeoutMs) {
          settled = true;
          clearInterval(poll);
          const fullText = this.paneManager.readNewOutput(agentName) || '';
          resolve({
            text: this._cleanResponse(fullText, provider),
            partial: true,
            timedOut: true,
          });
          return;
        }

        // Check if pane died
        if (this.paneManager.isPaneDead(agentName)) {
          settled = true;
          clearInterval(poll);
          const fullText = this.paneManager.readNewOutput(agentName) || '';
          resolve({
            text: this._cleanResponse(fullText, provider),
            partial: true,
            timedOut: false,
          });
          return;
        }

        // Check for new content by comparing actual output size
        const peeked = this.paneManager.peekNewOutput(agentName);
        const currentSize = peeked ? peeked.length : 0;

        if (currentSize > 0 && currentSize !== lastSize) {
          // File actually grew — real new data
          lastGrowthTime = Date.now();
          lastSize = currentSize;

          // Check if prompt pattern appeared (response done — fast path)
          if (provider.promptPattern && provider.promptPattern.test(peeked)) {
            // Wait one more poll to make sure nothing else is coming
            setTimeout(() => {
              const recheck = this.paneManager.peekNewOutput(agentName);
              const recheckSize = recheck ? recheck.length : 0;
              if (recheckSize === currentSize) {
                // No more growth — prompt is stable, we're done
                settled = true;
                clearInterval(poll);
                const fullText = this.paneManager.readNewOutput(agentName) || '';
                resolve({
                  text: this._cleanResponse(fullText, provider),
                  partial: false,
                  timedOut: false,
                });
              }
              // else more data came in, keep polling
            }, pollMs);
            return;
          }
        }

        // Silence check — file grew at some point but hasn't grown for silenceMs
        if (lastGrowthTime && currentSize > 0 && (Date.now() - lastGrowthTime > silenceMs)) {
          settled = true;
          clearInterval(poll);
          const fullText = this.paneManager.readNewOutput(agentName) || '';
          resolve({
            text: this._cleanResponse(fullText, provider),
            partial: false,
            timedOut: false,
          });
        }
      }, pollMs);
    });
  }

  /**
   * Clean up raw captured text:
   * - Strip provider-specific noise patterns
   * - Remove prompt lines at the end
   * - Trim whitespace
   */
  _cleanResponse(text, provider) {
    let cleaned = text;

    if (provider.stripPatterns) {
      for (const pattern of provider.stripPatterns) {
        cleaned = cleaned.replace(pattern, '');
      }
    }

    if (provider.promptPattern) {
      const lines = cleaned.split('\n');
      while (lines.length > 0 && provider.promptPattern.test(lines[lines.length - 1])) {
        lines.pop();
      }
      cleaned = lines.join('\n');
    }

    cleaned = cleaned.trim();
    return cleaned;
  }
}

module.exports = ResponseCapture;
