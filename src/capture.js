// src/capture.js
// ─────────────────────────────────────────────────────────
// Watches agent log files for response completion
// Uses byte-offset tracking + prompt detection + silence timeout
// ─────────────────────────────────────────────────────────
const fs = require('fs');

const DEFAULT_POLL_MS = 500;
const DEFAULT_SILENCE_MS = 3000;
const DEFAULT_TIMEOUT_MS = 120000;

class ResponseCapture {
  constructor(paneManager) {
    this.paneManager = paneManager;
  }

  /**
   * Wait for an agent's response to complete.
   * Records byte offset before sending, then polls for new content.
   * Returns the response text when done.
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
    const startOffset = pane.byteOffset;

    return new Promise((resolve) => {
      let lastNewDataTime = null;
      let accumulatedText = '';
      let settled = false;
      const startTime = Date.now();

      const poll = setInterval(() => {
        if (settled) return;

        // Check hard timeout
        if (Date.now() - startTime > timeoutMs) {
          settled = true;
          clearInterval(poll);
          accumulatedText = this.paneManager.readNewOutput(agentName) || accumulatedText;
          resolve({
            text: this._cleanResponse(accumulatedText, provider),
            partial: true,
            timedOut: true,
          });
          return;
        }

        // Check if pane died
        if (this.paneManager.isPaneDead(agentName)) {
          settled = true;
          clearInterval(poll);
          accumulatedText = this.paneManager.readNewOutput(agentName) || accumulatedText;
          resolve({
            text: this._cleanResponse(accumulatedText, provider),
            partial: true,
            timedOut: false,
          });
          return;
        }

        // Check for new content
        const newText = this.paneManager.peekNewOutput(agentName);
        if (newText && newText.length > 0) {
          lastNewDataTime = Date.now();
          accumulatedText = newText;

          // Check if prompt character appeared (response done)
          if (provider.promptPattern && provider.promptPattern.test(newText)) {
            // Wait one more poll to make sure nothing else is coming
            setTimeout(() => {
              const finalCheck = this.paneManager.peekNewOutput(agentName);
              if (!finalCheck || finalCheck === newText || finalCheck.length === newText.length) {
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

        // Silence check — if we got data but nothing new for silenceMs
        if (lastNewDataTime && (Date.now() - lastNewDataTime > silenceMs)) {
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
   * - Strip the input we sent (first lines are our message)
   * - Strip prompt characters
   * - Strip provider-specific noise
   */
  _cleanResponse(text, provider) {
    let cleaned = text;

    // Strip provider-specific patterns
    if (provider.stripPatterns) {
      for (const pattern of provider.stripPatterns) {
        cleaned = cleaned.replace(pattern, '');
      }
    }

    // Remove prompt lines at the end
    if (provider.promptPattern) {
      const lines = cleaned.split('\n');
      while (lines.length > 0 && provider.promptPattern.test(lines[lines.length - 1])) {
        lines.pop();
      }
      cleaned = lines.join('\n');
    }

    // Trim whitespace
    cleaned = cleaned.trim();

    return cleaned;
  }
}

module.exports = ResponseCapture;
