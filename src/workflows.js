// src/workflows.js
// ─────────────────────────────────────────────────────────
// Built-in workflows: /debate, /plan, /review, /research
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const PRESETS_DIR = path.join(require('os').homedir(), '.agent-ceo', 'presets');

// Built-in workflow definitions
const BUILTINS = {
  debate: {
    name: 'debate',
    description: 'Agents critique each other\'s last responses',
    minAgents: 2,
    instruction: (agentName, otherResponses) => {
      const others = otherResponses
        .map(r => `[${r.from.toUpperCase()}] said:\n${r.text}`)
        .join('\n\n---\n\n');
      return `The following responses were given by other agents:\n\n${others}\n\nYour task: Find holes, faulty reasoning, missing considerations, and incorrect assumptions in the above. Be critical and specific. Point out what you disagree with and why. Also acknowledge what they got right.`;
    },
  },

  plan: {
    name: 'plan',
    description: 'First agent architects, second agent pokes holes',
    minAgents: 2,
    maxAgents: 2,
    phases: [
      {
        role: 'architect',
        instruction: (topic) =>
          `You are the architect. Create a detailed plan for the following:\n\n${topic}\n\nInclude: approach, steps, risks, dependencies, and timeline. Be thorough.`,
      },
      {
        role: 'critic',
        instruction: (planText) =>
          `Another agent created the following plan:\n\n${planText}\n\nYour task: Review this plan for feasibility, edge cases, missing steps, security concerns, performance risks, and anything the architect overlooked. Be critical but constructive.`,
      },
    ],
  },

  review: {
    name: 'review',
    description: 'First agent implements, second agent reviews',
    minAgents: 2,
    maxAgents: 2,
    phases: [
      {
        role: 'implementer',
        instruction: (task) =>
          `Implement the following:\n\n${task}\n\nYou have WRITE permission. Make the changes.`,
        writeMode: true,
      },
      {
        role: 'reviewer',
        instruction: (implText) =>
          `Another agent implemented changes. Here is their response:\n\n${implText}\n\nReview for: correctness, security vulnerabilities, edge cases, code style, test coverage. Be specific about what needs fixing.`,
      },
    ],
  },

  research: {
    name: 'research',
    description: 'All agents investigate independently, then report',
    minAgents: 1,
    instruction: (topic) =>
      `Research the following independently:\n\n${topic}\n\nInvestigate thoroughly. Report your findings with evidence. Do not respond to other agents — this is independent research.`,
  },
};

class WorkflowManager {
  constructor(agentManager, inboxManager, paneManager, capture, session, chatroom) {
    this.agentManager = agentManager;
    this.inboxManager = inboxManager;
    this.paneManager = paneManager;
    this.capture = capture;
    this.session = session;
    this.chatroom = chatroom;
    this.customPresets = {};
    this.loadCustomPresets();
  }

  // ── Execute built-in workflows ─────────────────────────

  async runDebate(agentNames, topic) {
    if (agentNames.length < 2) {
      return { error: 'Debate needs at least 2 agents.' };
    }

    // First round: all agents respond to the topic
    if (topic) {
      this.chatroom.printSystem(`Starting debate: ${topic}`);
      for (const name of agentNames) {
        this.inboxManager.pushTo(name, 'ceo', topic);
      }
      // Get initial responses
      const responses = [];
      for (const name of agentNames) {
        await this.chatroom.sendToAgent(name, false);
        const lastLog = this.session.chatLog.filter(e => e.from === name).pop();
        if (lastLog) responses.push({ from: name, text: lastLog.text });
      }

      // Second round: each agent critiques the others
      this.chatroom.printSystem('Round 2: Cross-critique');
      for (const name of agentNames) {
        const otherResponses = responses.filter(r => r.from !== name);
        const instruction = BUILTINS.debate.instruction(name, otherResponses);
        this.inboxManager.pushTo(name, 'system', instruction);
        await this.chatroom.sendToAgent(name, false);
      }
    } else {
      // No topic — debate last responses
      const lastResponses = [];
      for (const name of agentNames) {
        const lastLog = this.session.chatLog.filter(e => e.from === name).pop();
        if (lastLog) lastResponses.push({ from: name, text: lastLog.text });
      }

      if (lastResponses.length < 2) {
        return { error: 'Agents need previous responses to debate. Provide a topic or have agents respond first.' };
      }

      this.chatroom.printSystem('Starting debate on previous responses');
      for (const name of agentNames) {
        const otherResponses = lastResponses.filter(r => r.from !== name);
        const instruction = BUILTINS.debate.instruction(name, otherResponses);
        this.inboxManager.pushTo(name, 'system', instruction);
        await this.chatroom.sendToAgent(name, false);
      }
    }

    return { ok: true };
  }

  async runPlan(agents, topic) {
    if (agents.length !== 2) {
      return { error: '/plan needs exactly 2 agents: /plan <architect> <critic>' };
    }
    if (!topic) {
      return { error: 'Provide a topic: /plan agent1 agent2 <description>' };
    }

    const [architect, critic] = agents;

    // Phase 1: Architect plans
    this.chatroom.printSystem(`${this.agentManager.displayName(architect)} is architecting...`);
    const archInstruction = BUILTINS.plan.phases[0].instruction(topic);
    this.inboxManager.pushTo(architect, 'system', archInstruction);
    await this.chatroom.sendToAgent(architect, false);

    // Get architect's response
    const archResponse = this.session.chatLog.filter(e => e.from === architect).pop();
    if (!archResponse) return { error: 'Architect produced no response.' };

    // Phase 2: Critic reviews
    this.chatroom.printSystem(`${this.agentManager.displayName(critic)} is reviewing the plan...`);
    const criticInstruction = BUILTINS.plan.phases[1].instruction(archResponse.text);
    this.inboxManager.pushTo(critic, 'system', criticInstruction);
    await this.chatroom.sendToAgent(critic, false);

    return { ok: true };
  }

  async runReview(agents, task) {
    if (agents.length !== 2) {
      return { error: '/review needs exactly 2 agents: /review <implementer> <reviewer>' };
    }
    if (!task) {
      return { error: 'Provide a task: /review agent1 agent2 <description>' };
    }

    const [implementer, reviewer] = agents;

    // Phase 1: Implement
    this.chatroom.printSystem(`${this.agentManager.displayName(implementer)} is implementing...`);
    const implInstruction = BUILTINS.review.phases[0].instruction(task);
    this.inboxManager.pushTo(implementer, 'system', implInstruction);
    await this.chatroom.sendToAgent(implementer, true); // write mode

    // Get implementer's response
    const implResponse = this.session.chatLog.filter(e => e.from === implementer).pop();
    if (!implResponse) return { error: 'Implementer produced no response.' };

    // Phase 2: Review
    this.chatroom.printSystem(`${this.agentManager.displayName(reviewer)} is reviewing...`);
    const reviewInstruction = BUILTINS.review.phases[1].instruction(implResponse.text);
    this.inboxManager.pushTo(reviewer, 'system', reviewInstruction);
    await this.chatroom.sendToAgent(reviewer, false);

    return { ok: true };
  }

  async runResearch(agentNames, topic) {
    if (!topic) {
      return { error: 'Provide a topic: /research <description>' };
    }

    this.chatroom.printSystem(`Sending ${agentNames.length} agents to research...`);
    const instruction = BUILTINS.research.instruction(topic);

    // Send to all in parallel
    for (const name of agentNames) {
      this.inboxManager.pushTo(name, 'system', instruction);
    }
    const promises = agentNames.map(name => this.chatroom.sendToAgent(name, false));
    await Promise.all(promises);

    return { ok: true };
  }

  // ── Custom presets ─────────────────────────────────────

  loadCustomPresets() {
    // Reserved for future custom workflow definitions
  }

  listPresets() {
    const all = [];
    for (const [name, def] of Object.entries(BUILTINS)) {
      all.push({ name: `/${name}`, description: def.description, builtin: true });
    }
    return all;
  }
}

module.exports = WorkflowManager;
module.exports.BUILTINS = BUILTINS;
