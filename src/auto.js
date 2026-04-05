'use strict';

const KNOWN_STEPS = [
  'plan', 'debate', 'consensus', 'implement', 'review', 'fix', 'verify',
];

const DEFAULT_PIPELINE = ['plan', 'debate', 'consensus', 'implement', 'review'];

// ---------------------------------------------------------------------------
// AutoRunner — core state machine and utilities for /auto autonomous pipeline
// ---------------------------------------------------------------------------
class AutoRunner {
  constructor() {
    this.state = 'idle';          // idle | running | paused
    this._nextJobId = 1;
    this.jobs = [];               // completed / stopped jobs
    this.currentJob = null;
  }

  // ---- Static constants ---------------------------------------------------
  static get KNOWN_STEPS() { return KNOWN_STEPS; }
  static get DEFAULT_PIPELINE() { return DEFAULT_PIPELINE; }

  // ---- Role assignment (static) -------------------------------------------
  static assignRoles(agents, overrides = {}) {
    if (overrides.noRoles) {
      return {
        planner: null,
        implementer: null,
        reviewer: null,
        critics: [],
        noRoles: true,
      };
    }

    const solo = agents.length === 1;
    if (solo) {
      return {
        planner: agents[0],
        implementer: agents[0],
        reviewer: agents[0],
        critics: [],
        solo: true,
      };
    }

    // Defaults: planner = first, implementer = planner, reviewer = last different from planner
    let planner = overrides.planner || agents[0];
    let implementer = overrides.implementer || planner;
    // reviewer defaults to last agent that is not the implementer
    let reviewer = overrides.reviewer || [...agents].reverse().find(a => a !== implementer) || agents[agents.length - 1];

    // Critics: all non-planner agents (default), or override
    let critics;
    if (overrides.critic) {
      critics = Array.isArray(overrides.critic) ? overrides.critic : [overrides.critic];
    } else {
      critics = agents.filter(a => a !== planner);
    }

    return { planner, implementer, reviewer, critics };
  }

  // ---- Pipeline validation (static) ---------------------------------------
  static validatePipeline(steps) {
    for (const step of steps) {
      if (!KNOWN_STEPS.includes(step)) {
        throw new Error(`Unknown step: ${step}`);
      }
    }
  }

  // ---- Consensus parsing (static) -----------------------------------------
  static parseConsensus(text) {
    const lines = text.split('\n');
    // Scan from end to find the consensus line
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^CONSENSUS:\s*(YES|NO)\s*$/i);
      if (m) {
        const vote = m[1].toUpperCase();
        let blockers = null;
        // Check next lines for BLOCKERS:
        for (let j = i + 1; j < lines.length; j++) {
          const bm = lines[j].match(/^BLOCKERS:\s*(.+)$/i);
          if (bm) {
            blockers = bm[1].trim();
            break;
          }
        }
        return { vote, blockers };
      }
    }
    return null;
  }

  // ---- Review parsing (static) --------------------------------------------
  static parseReview(text) {
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^REVIEW:\s*(APPROVE|REQUEST_CHANGES)(?:\s*[—–\-]\s*(.+))?$/i);
      if (m) {
        const decision = m[1].toUpperCase();
        const feedback = m[2] ? m[2].trim() : null;
        return { decision, feedback };
      }
    }
    return null;
  }

  // ---- Plan format parsing (static) ---------------------------------------
  static parsePlanFormat(text) {
    const summaryMatch = text.match(/PLAN_SUMMARY:\s*\n([\s\S]*?)(?=\n\s*\n|\nACCEPTANCE_CRITERIA:|$)/i);
    const criteriaMatch = text.match(/ACCEPTANCE_CRITERIA:\s*\n([\s\S]*?)$/i);

    if (!summaryMatch || !criteriaMatch) return null;

    return {
      planSummary: summaryMatch[1].trim(),
      acceptanceCriteria: criteriaMatch[1].trim(),
    };
  }

  // ---- Compact output formatting (static) ---------------------------------
  static formatCompact({ round, maxRounds, step, agentName, text, tokenEstimate }) {
    const header = `[Round ${round}/${maxRounds}] ${step} | ${agentName}`;

    // Check for consensus token
    const consensus = AutoRunner.parseConsensus(text);
    if (consensus) {
      return `${header} | CONSENSUS: ${consensus.vote}${consensus.blockers ? ` | BLOCKERS: ${consensus.blockers}` : ''} (${tokenEstimate} tok)`;
    }

    // Check for review token
    const review = AutoRunner.parseReview(text);
    if (review) {
      return `${header} | REVIEW: ${review.decision}${review.feedback ? ` — ${review.feedback}` : ''} (${tokenEstimate} tok)`;
    }

    // Normal: truncated first line + token count
    const firstLine = text.split('\n')[0];
    const truncated = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
    return `${header} | ${truncated} (${tokenEstimate} tok)`;
  }

  // ---- State machine: job lifecycle ---------------------------------------
  createJob({ goal, pipeline, participants, maxRounds, maxTimeMs }) {
    if (this.currentJob && this.currentJob.state === 'running') {
      throw new Error('Job already running');
    }
    if (this.state === 'paused') {
      throw new Error('Runner is paused — resume or stop first');
    }

    const id = this._nextJobId++;
    const now = Date.now();
    const roles = AutoRunner.assignRoles(participants);

    const job = {
      id,
      goal,
      pipeline: [...pipeline],
      participants: [...participants],
      roles,
      maxRounds,
      maxTimeMs,
      state: 'running',
      round: 0,
      stepIndex: 0,
      responses: [],
      startedAt: now,
      finishedAt: null,
    };

    this.currentJob = job;
    this.state = 'running';
    return job;
  }

  pause(reason) {
    if (this.state !== 'running') return;
    this.state = 'paused';
    if (this.currentJob) {
      this.currentJob.pauseReason = reason || 'manual';
    }
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'running';
    if (this.currentJob) {
      delete this.currentJob.pauseReason;
    }
  }

  stop(journal = null) {
    if (this.currentJob) {
      this.currentJob.state = 'stopped';
      this.currentJob.finishedAt = Date.now();
      if (journal && typeof journal.write === 'function') {
        journal.write({ type: 'auto:stop', jobId: this.currentJob.id, ts: this.currentJob.finishedAt });
      }
      this.jobs.push(this.currentJob);
      this.currentJob = null;
    }
    this.state = 'idle';
  }

  complete(journal = null) {
    if (this.currentJob) {
      this.currentJob.state = 'completed';
      this.currentJob.finishedAt = Date.now();
      if (journal && typeof journal.write === 'function') {
        journal.write({ type: 'auto:complete', jobId: this.currentJob.id, ts: this.currentJob.finishedAt });
      }
      this.jobs.push(this.currentJob);
      this.currentJob = null;
    }
    this.state = 'idle';
  }

  recordResponse(round, step, agent, text, role = null) {
    if (!this.currentJob) return;
    const tokenEstimate = Math.ceil(text.length / 4);
    const entry = { round, step, agent, text, role, tokenEstimate, ts: Date.now() };
    this.currentJob.responses.push(entry);
    return entry;
  }

  setRounds(n) {
    if (this.currentJob) this.currentJob.maxRounds = n;
  }

  addRounds(n) {
    if (this.currentJob) this.currentJob.maxRounds += n;
  }

  isOverLimits() {
    if (!this.currentJob) return false;
    const { round, maxRounds, startedAt, maxTimeMs } = this.currentJob;
    if (round >= maxRounds) return true;
    if (Date.now() - startedAt >= maxTimeMs) return true;
    return false;
  }

  getStatus() {
    return {
      state: this.state,
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        goal: this.currentJob.goal,
        round: this.currentJob.round,
        maxRounds: this.currentJob.maxRounds,
        step: this.currentJob.pipeline[this.currentJob.stepIndex] || null,
        responses: this.currentJob.responses.length,
        elapsed: Date.now() - this.currentJob.startedAt,
      } : null,
      totalJobs: this.jobs.length + (this.currentJob ? 1 : 0),
    };
  }

  getJob(id) {
    if (this.currentJob && this.currentJob.id === id) return this.currentJob;
    return this.jobs.find(j => j.id === id) || null;
  }

  getLastJob() {
    if (this.currentJob) return this.currentJob;
    return this.jobs.length ? this.jobs[this.jobs.length - 1] : null;
  }
}

module.exports = AutoRunner;
