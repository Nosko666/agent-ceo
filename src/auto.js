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
  createJob({ goal, pipeline, participants, maxRounds, maxTimeMs, roles, verbose }) {
    if (this.currentJob && this.currentJob.state === 'running') {
      throw new Error('Job already running');
    }
    if (this.state === 'paused') {
      throw new Error('Runner is paused — resume or stop first');
    }

    const id = this._nextJobId++;
    const now = Date.now();
    const assignedRoles = roles || AutoRunner.assignRoles(participants);

    const job = {
      id,
      goal,
      pipeline: [...pipeline],
      participants: [...participants],
      roles: assignedRoles,
      maxRounds,
      maxTimeMs,
      verbose: verbose || false,
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
    if (this.state !== 'paused') return false;
    this.state = 'running';
    if (this.currentJob) {
      delete this.currentJob.pauseReason;
    }
    return true;
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

  // ===========================================================================
  // Pipeline execution
  // ===========================================================================

  /**
   * Execute the pipeline. Called by chatroom after createJob().
   * @param {object} chatroom - Chatroom instance (has sendAndCapture, journal, inboxManager, etc.)
   */
  async run(chatroom) {
    const job = this.currentJob;
    if (!job) return;

    const { printSystem, printWarning } = require('./display');

    if (job.roles.solo) {
      printSystem('Solo mode: 1 agent, self-critique/self-review enabled.');
    }

    while (job.state === 'running' && job.stepIndex < job.pipeline.length) {
      if (this.isOverLimits()) {
        printWarning(`Auto job ${job.id}: limits reached (round ${job.round}/${job.maxRounds}). /auto resume --rounds N to extend.`);
        this.pause('max_rounds');
        if (chatroom.journal) chatroom.journal.append({ type: 'auto_pause', jobId: job.id, reason: 'max_rounds' });
        return;
      }

      const stepName = job.pipeline[job.stepIndex];
      job.currentStepName = stepName;

      let advance = false;
      switch (stepName) {
        case 'plan':
          advance = await this._runPlanStep(chatroom, job);
          break;
        case 'debate':
          advance = await this._runDebateStep(chatroom, job);
          break;
        case 'consensus':
          advance = await this._runConsensusStep(chatroom, job);
          break;
        case 'implement':
          advance = await this._runImplementStep(chatroom, job);
          break;
        case 'review':
          advance = await this._runReviewStep(chatroom, job);
          break;
      }

      if (job.state !== 'running') return; // paused or stopped mid-step

      if (advance) {
        job.stepIndex++;
      }
      // If !advance, the step loops (e.g., review → implement loop)
    }

    if (job.state === 'running') {
      this.complete(chatroom.journal);
      const lastJob = this.jobs[this.jobs.length - 1];
      printSystem(`Auto job ${lastJob.id}: completed (${lastJob.round} rounds).`);
    }
  }

  // ---- Core send wrapper ----------------------------------------------------

  async _sendToAgent(chatroom, job, agentName, prompt, options = {}) {
    // Check limits BEFORE incrementing (prevents off-by-one)
    if (this.isOverLimits()) {
      this.pause('max_rounds');
      return null;
    }

    job.round++;

    // Flush the agent's inbox first so it sees other agents' responses,
    // then prepend the /auto prompt. This is how agents "see each other."
    const inboxContent = chatroom.inboxManager.flush(agentName);
    if (chatroom.journal) {
      chatroom.journal.append({ type: 'inbox_flush', agent: agentName });
    }
    const fullPrompt = inboxContent ? inboxContent + '\n\n' + prompt : prompt;

    const journalMeta = {
      autoJobId: job.id,
      step: job.currentStepName,
      round: job.round,
      role: options.role || null,
    };

    // Use display:'hidden' — AutoRunner handles its own output formatting.
    // forceReadOnly prevents persistent /mode write from leaking into non-writer steps.
    const result = await chatroom.sendAndCapture(agentName, fullPrompt, {
      writeMode: options.writeMode || false,
      forceReadOnly: !options.writeMode,
      display: job.verbose ? 'full' : 'hidden',
      broadcastTo: job.participants.filter(p => p !== agentName),
      journalMeta,
    });

    if (!result || !result.text) {
      this.pause('capture_timeout');
      job.waitingOn = agentName;
      const { printWarning: pw } = require('./display');
      pw(`No reply from ${agentName}. /focus ${agentName} to check, then /auto resume.`);
      if (chatroom.journal) {
        chatroom.journal.append({ type: 'auto_pause', jobId: job.id, reason: 'capture_timeout' });
      }
      return null;
    }

    // Store role in response for filtering in plan step
    this.recordResponse(job.round, job.currentStepName, agentName, result.text, options.role);

    // Print compact output when not verbose (verbose uses sendAndCapture display:'full')
    if (!job.verbose) {
      const compact = AutoRunner.formatCompact({
        round: job.round,
        maxRounds: job.maxRounds,
        step: job.currentStepName,
        agentName,
        text: result.text,
        tokenEstimate: Math.ceil(result.text.length / 4),
      });
      console.log(compact);
    }

    return result;
  }

  // ---- Plan step: full critique cycle ---------------------------------------

  async _runPlanStep(chatroom, job) {
    let BUILTINS;
    try { BUILTINS = require('./workflows').BUILTINS || {}; } catch (_) { BUILTINS = {}; }
    const { printSystem } = require('./display');

    const planner = job.roles.noRoles ? job.participants[0] : job.roles.planner;
    const critics = job.roles.noRoles ? job.participants.slice(1) : job.roles.critics;

    // Architect prompt
    const archPrompt = BUILTINS.plan && BUILTINS.plan.phases
      ? BUILTINS.plan.phases[0].instruction(job.goal)
      : `Create a detailed plan for:\n\n${job.goal}\n\nInclude approach, steps, risks, dependencies.`;

    const planPrompt = archPrompt + '\n\nIMPORTANT: End your response with these exact sections:\nPLAN:\n(full details)\n\nPLAN_SUMMARY:\n(\u226412 bullet points)\n\nACCEPTANCE_CRITERIA:\n(what "done" means)';

    let planResult = await this._sendToAgent(chatroom, job, planner, planPrompt, { role: 'planner' });
    if (!planResult) return false;

    // Critique + revision loop until consensus
    let consensusReached = false;
    while (!consensusReached && job.state === 'running' && !this.isOverLimits()) {
      // Critics critique
      for (const critic of critics) {
        if (job.state !== 'running' || this.isOverLimits()) break;
        const critiquePrompt = BUILTINS.plan && BUILTINS.plan.phases
          ? BUILTINS.plan.phases[1].instruction(planResult.text)
          : `Review this plan:\n\n${planResult.text}\n\nBe critical. What's missing, wrong, or risky?`;
        const critiqueWithToken = critiquePrompt + '\n\nEnd with:\nCONSENSUS: YES or CONSENSUS: NO\nBLOCKERS: (list issues, or empty if YES)';

        const critiqueResult = await this._sendToAgent(chatroom, job, critic, critiqueWithToken, { role: 'critic' });
        if (!critiqueResult) return false;

        const consensus = AutoRunner.parseConsensus(critiqueResult.text);
        if (!consensus) {
          // Reprompt once
          const reprompt = await this._sendToAgent(chatroom, job, critic,
            'Format error: end with exactly one of:\nCONSENSUS: YES\nCONSENSUS: NO\nBLOCKERS: (issues)\n\nRestate your verdict.', { role: 'critic' });
          if (!reprompt) return false;
        }
      }

      // Check if all critics said YES after the LATEST planner revision
      const plannerRounds = job.responses.filter(r => r.step === 'plan' && r.role === 'planner');
      const lastPlannerRound = plannerRounds.length > 0 ? plannerRounds[plannerRounds.length - 1].round : 0;
      const recentCritics = job.responses.filter(r =>
        r.step === 'plan' && r.role === 'critic' && r.round > lastPlannerRound
      );
      const allYes = recentCritics.length > 0 && recentCritics.every(r => {
        const c = AutoRunner.parseConsensus(r.text);
        return c && c.vote === 'YES';
      });

      if (allYes || job.roles.solo) {
        consensusReached = true;
      } else if (job.state === 'running' && !this.isOverLimits()) {
        // Planner revises
        const revisePrompt = 'Revise your plan based on the critique above.\n\nIMPORTANT: End with:\nPLAN:\n(details)\n\nPLAN_SUMMARY:\n(\u226412 bullets)\n\nACCEPTANCE_CRITERIA:\n(what "done" means)';
        planResult = await this._sendToAgent(chatroom, job, planner, revisePrompt, { role: 'planner' });
        if (!planResult) return false;
      }
    }

    // Extract and cache plan summary
    const planFormat = AutoRunner.parsePlanFormat(planResult.text);
    if (planFormat) {
      job.planSummary = planFormat.planSummary;
      job.acceptanceCriteria = planFormat.acceptanceCriteria;
    } else if (job.state === 'running') {
      // Reprompt once for format
      const reprompt = await this._sendToAgent(chatroom, job, planner,
        'Format error: your plan must include PLAN_SUMMARY: and ACCEPTANCE_CRITERIA: sections. Restate.', { role: 'planner' });
      if (reprompt) {
        const fmt = AutoRunner.parsePlanFormat(reprompt.text);
        if (fmt) {
          job.planSummary = fmt.planSummary;
          job.acceptanceCriteria = fmt.acceptanceCriteria;
        } else {
          this.pause('plan_format_error');
          return false;
        }
      }
    }

    printSystem('Plan approved. Summary cached.');
    return true;
  }

  // ---- Debate step (standalone extra scrutiny) ------------------------------

  async _runDebateStep(chatroom, job) {
    let BUILTINS;
    try { BUILTINS = require('./workflows').BUILTINS || {}; } catch (_) { BUILTINS = {}; }

    const agents = job.roles.noRoles ? job.participants : [...job.roles.critics, job.roles.planner];

    for (const agent of agents) {
      if (job.state !== 'running' || this.isOverLimits()) break;
      const topic = job.planSummary || job.goal;

      let prompt;
      if (job.roles.solo) {
        prompt = `Critique your own previous output:\n\n${topic}\n\nFind holes, faulty reasoning, and missing considerations.`;
      } else if (BUILTINS.debate) {
        const otherResponses = job.responses
          .filter(r => r.agent !== agent)
          .slice(-3)
          .map(r => ({ from: r.agent, text: r.text }));
        prompt = BUILTINS.debate.instruction(agent, otherResponses);
      } else {
        prompt = `Debate the following:\n\n${topic}`;
      }

      await this._sendToAgent(chatroom, job, agent, prompt, { role: 'critic' });
    }
    return true;
  }

  // ---- Consensus step -------------------------------------------------------

  async _runConsensusStep(chatroom, job) {
    const { printSystem } = require('./display');
    const agents = job.participants;

    for (const agent of agents) {
      if (job.state !== 'running' || this.isOverLimits()) break;
      const prompt = 'Based on the discussion so far, state your verdict.\n\nEnd with exactly:\nCONSENSUS: YES or CONSENSUS: NO\nBLOCKERS: (list issues, or empty if YES)';

      const result = await this._sendToAgent(chatroom, job, agent, prompt, { role: 'voter' });
      if (!result) return false;

      let consensus = AutoRunner.parseConsensus(result.text);
      if (!consensus) {
        // Reprompt once
        const reprompt = await this._sendToAgent(chatroom, job, agent,
          'Format error: end with exactly:\nCONSENSUS: YES\nCONSENSUS: NO\nBLOCKERS: ...\nRestate.', { role: 'voter' });
        if (reprompt) consensus = AutoRunner.parseConsensus(reprompt.text);
        if (!consensus) consensus = { vote: 'NO', blockers: 'missing/invalid consensus token' };
      }
    }

    // Check results
    const votes = job.responses.filter(r => r.step === 'consensus').slice(-agents.length);
    const allYes = votes.every(r => {
      const c = AutoRunner.parseConsensus(r.text);
      return c && c.vote === 'YES';
    });

    if (allYes) {
      printSystem('Consensus reached.');
      return true;
    }

    // No consensus — loop back to debate if debate is in pipeline
    if (job.pipeline.includes('debate')) {
      job.stepIndex = job.pipeline.indexOf('debate');
      return false; // don't advance, loop
    }

    return true; // no debate to loop to, just continue
  }

  // ---- Implement step -------------------------------------------------------

  async _runImplementStep(chatroom, job) {
    const implementer = job.roles.noRoles ? job.participants[0] : job.roles.implementer;
    const context = job.planSummary
      ? `Goal: ${job.goal}\n\nPlan Summary:\n${job.planSummary}`
      : `Goal: ${job.goal}`;

    const prompt = `${context}\n\nImplement this plan. You have WRITE permission.`;
    await this._sendToAgent(chatroom, job, implementer, prompt, { role: 'implementer', writeMode: true });
    return true;
  }

  // ---- Review step ----------------------------------------------------------

  async _runReviewStep(chatroom, job) {
    const { printSystem } = require('./display');
    const reviewer = job.roles.noRoles
      ? job.participants[job.participants.length > 1 ? 1 : 0]
      : job.roles.reviewer;
    const criteria = job.acceptanceCriteria || 'correctness, security, edge cases, code quality';

    const prompt = `Review the implementation above against these criteria:\n\n${criteria}\n\nEnd with exactly:\nREVIEW: APPROVE\nor\nREVIEW: REQUEST_CHANGES \u2014 (reason)`;

    const result = await this._sendToAgent(chatroom, job, reviewer, prompt, { role: 'reviewer' });
    if (!result) return false;

    let reviewResult = AutoRunner.parseReview(result.text);
    if (!reviewResult) {
      // Reprompt once
      const reprompt = await this._sendToAgent(chatroom, job, reviewer,
        'Format error: end with exactly:\nREVIEW: APPROVE\nor\nREVIEW: REQUEST_CHANGES \u2014 (reason)\nRestate.', { role: 'reviewer' });
      if (reprompt) reviewResult = AutoRunner.parseReview(reprompt.text);
      if (!reviewResult) reviewResult = { decision: 'REQUEST_CHANGES', feedback: 'missing/invalid review token' };
    }

    if (reviewResult.decision === 'APPROVE') {
      printSystem('Review: APPROVED');
      return true;
    }

    // REQUEST_CHANGES — loop back to implement
    if (job.pipeline.includes('implement') && !this.isOverLimits()) {
      printSystem('Review: REQUEST_CHANGES. Looping back to implement.');

      // Re-run implement with feedback
      const implementer = job.roles.noRoles ? job.participants[0] : job.roles.implementer;
      const revisionPrompt = `Goal: ${job.goal}\n\n${job.planSummary ? `Plan Summary:\n${job.planSummary}\n\n` : ''}Reviewer feedback:\n${reviewResult.feedback || result.text}\n\nRevise your implementation to address the above. You have WRITE permission.`;
      await this._sendToAgent(chatroom, job, implementer, revisionPrompt, { role: 'implementer', writeMode: true });

      return false; // don't advance — re-run review
    }

    return true;
  }
}

module.exports = AutoRunner;
