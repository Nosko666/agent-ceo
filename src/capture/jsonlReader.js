// src/capture/jsonlReader.js
// ─────────────────────────────────────────────────────────
// Shared utilities for reading JSONL session files
// Used by both claudeCapture.js and codexCapture.js
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Compute Claude Code JSONL path from session ID and project dir.
 * Claude stores sessions at ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
 * where encoded-cwd replaces non-alphanumeric chars with -
 */
function claudeJsonlPath(sessionId, projectDir) {
  const encoded = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

/**
 * Read a chunk of bytes from a file starting at fromByte.
 * Returns { chunk: string, newSize: number } or null if no new data.
 */
function readChunk(filePath, fromByte) {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= fromByte) return null;

    const length = stats.size - fromByte;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, fromByte);
    fs.closeSync(fd);

    return { chunk: buffer.toString('utf-8'), newSize: stats.size };
  } catch {
    return null;
  }
}

/**
 * Split a chunk into complete JSONL lines.
 * Drops the last line if it doesn't end with \n (incomplete/truncated write).
 * Returns { lines: string[], remainder: string }
 */
function splitCompleteLines(chunk, previousRemainder = '') {
  const combined = previousRemainder + chunk;
  const parts = combined.split('\n');

  // If chunk doesn't end with \n, last part is incomplete
  const remainder = combined.endsWith('\n') ? '' : parts.pop();
  const lines = parts.filter(l => l.trim().length > 0);

  return { lines, remainder };
}

/**
 * Parse a single JSONL line. Returns parsed object or null on failure.
 */
function parseLine(line) {
  try {
    return JSON.parse(line.trim());
  } catch {
    return null;
  }
}

/**
 * Poll until checkFn returns a truthy value, or timeout.
 * checkFn is called every pollMs. Returns the truthy value or null on timeout.
 */
function pollUntil(checkFn, { pollMs = 500, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const poll = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(poll);
        resolve(null);
        return;
      }

      const result = checkFn();
      if (result) {
        clearInterval(poll);
        resolve(result);
      }
    }, pollMs);
  });
}

module.exports = { claudeJsonlPath, readChunk, splitCompleteLines, parseLine, pollUntil };
