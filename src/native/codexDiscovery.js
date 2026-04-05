// src/native/codexDiscovery.js
// ─────────────────────────────────────────────────────────
// Codex session ID discovery via marker scanning
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

function generateMarker(agentName) {
  return `AGENT_CEO_MARKER=${agentName}:${crypto.randomUUID()}`;
}

function scanForMarker(text, marker) {
  return text.includes(marker);
}

function scanFileChunk(filePath, fromByte, marker, prevOverlap = '') {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= fromByte) {
      return { found: false, bytesRead: fromByte, overlapBuffer: prevOverlap };
    }

    const length = stats.size - fromByte;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, length, fromByte);
    fs.closeSync(fd);

    const chunk = buffer.toString('utf-8');
    const searchText = prevOverlap + chunk;

    if (searchText.includes(marker)) {
      return { found: true, bytesRead: stats.size, overlapBuffer: '' };
    }

    const overlapLen = Math.min(marker.length - 1, chunk.length);
    const overlapBuffer = chunk.substring(chunk.length - overlapLen);

    return { found: false, bytesRead: stats.size, overlapBuffer };
  } catch {
    return { found: false, bytesRead: fromByte, overlapBuffer: prevOverlap };
  }
}

function findCandidateFiles(baseDir, minMtime, maxDepth = 4) {
  const results = [];

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.name.startsWith('rollout') && entry.name.endsWith('.jsonl')) {
          try {
            const stats = fs.statSync(fullPath);
            if (stats.mtimeMs >= minMtime) {
              results.push({ path: fullPath, mtime: stats.mtimeMs });
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Try date dirs first (today +/- 1 day)
  const now = new Date();
  for (let offset = -1; offset <= 1; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const dateDir = path.join(baseDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'));
    if (fs.existsSync(dateDir)) {
      walk(dateDir, 0);
    }
  }

  // Fallback: full recursive walk if no results from date dirs
  if (results.length === 0) {
    walk(baseDir, 0);
  }

  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

function extractSessionId(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // Look for session identifier in various Codex metadata formats
        if (obj.session_id) return obj.session_id;
        if (obj.id) return obj.id;
        if (obj.metadata && obj.metadata.session_id) return obj.metadata.session_id;
      } catch { /* not JSON, skip */ }
    }
    // Fallback: derive from filename (rollout-<id>.jsonl)
    const basename = path.basename(filePath, '.jsonl');
    const match = basename.match(/rollout-(.+)/);
    if (match) return match[1];
  } catch { /* ignore */ }
  return null;
}

function validateCwd(line, expectedProjectDir) {
  try {
    const meta = JSON.parse(line);
    const cwd = meta.cwd || meta.project_dir || meta.working_directory || '';
    if (!cwd) return true; // can't validate, accept
    const resolved = fs.realpathSync(cwd);
    const expected = fs.realpathSync(expectedProjectDir);
    return resolved.startsWith(expected);
  } catch {
    return true; // can't parse, accept
  }
}

function startDiscovery({ marker, agentName, sessionsDir, agentStartTime, projectDir, onFound }) {
  const baseDir = sessionsDir || process.env.AGENT_CEO_CODEX_SESSIONS_DIR || DEFAULT_SESSIONS_DIR;
  let cancelled = false;
  let pollDelay = POLL_INITIAL_MS;
  const fileState = new Map();

  const promise = new Promise((resolve) => {
    const startTime = Date.now();

    function poll() {
      if (cancelled) { resolve(null); return; }
      if (Date.now() - startTime > POLL_TIMEOUT_MS) { resolve(null); return; }

      const files = findCandidateFiles(baseDir, agentStartTime);

      for (const file of files) {
        const state = fileState.get(file.path) || { bytesRead: 0, overlapBuffer: '' };
        const result = scanFileChunk(file.path, state.bytesRead, marker, state.overlapBuffer);
        fileState.set(file.path, { bytesRead: result.bytesRead, overlapBuffer: result.overlapBuffer });

        if (result.found) {
          // Validate cwd matches project dir
          if (projectDir) {
            try {
              const content = fs.readFileSync(file.path, 'utf-8');
              const firstLine = content.split('\n')[0];
              if (!validateCwd(firstLine, projectDir)) {
                // Wrong project — skip this file, keep scanning
                continue;
              }
            } catch { /* can't read, accept */ }
          }
          const sessionId = extractSessionId(file.path);
          if (onFound) onFound(sessionId || file.path);
          resolve(sessionId || file.path);
          return;
        }
      }

      pollDelay = Math.min(pollDelay * 1.5, POLL_MAX_MS);
      setTimeout(poll, pollDelay);
    }

    setTimeout(poll, POLL_INITIAL_MS);
  });

  return {
    promise,
    cancel() { cancelled = true; },
  };
}

module.exports = {
  generateMarker,
  scanForMarker,
  scanFileChunk,
  findCandidateFiles,
  extractSessionId,
  validateCwd,
  startDiscovery,
  DEFAULT_SESSIONS_DIR,
};
