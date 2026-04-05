// src/commands.js
// ─────────────────────────────────────────────────────────
// All /command handlers extracted from Chatroom class.
// Each function takes ctx (managers) + args.
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const { C, printSystem, printError, printWarning, printDim, printAgent, progressBar } = require('./display');

// ── Agent management ──────────────────────────────────────

function cmdAgents(ctx) {
  const agents = ctx.agentManager.list();
  if (agents.length === 0) {
    printSystem('No agents active.');
    return;
  }
  printSystem('Active agents:');
  for (const a of agents) {
    const statusColor = a.status === 'idle' ? C.green
      : a.status === 'running' ? C.yellow
      : a.status === 'dead' ? C.red : C.dim;
    const nameStr = a.displayName !== a.name ? `${a.name} (${a.displayName})` : a.name;
    console.log(`  ${statusColor}◉${C.reset} ${nameStr} [${a.provider}] ${statusColor}${a.status}${C.reset} inbox:${a.inbox}`);
  }
}

function cmdSpawn(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /spawn <provider> (e.g. /spawn claude)');
    return;
  }
  const result = ctx.agentManager.spawn(args[0]);
  if (result.error) {
    printError(result.error);
  } else {
    ctx.paneManager.arrangeLayout();
    printSystem(`Spawned ${result.name}`);
  }
}

function cmdKill(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /kill <agent>');
    return;
  }
  const result = ctx.agentManager.kill(args[0]);
  if (result.error) {
    printError(result.error);
  } else {
    printSystem(`Killed ${result.killed}`);
  }
}

function cmdRevive(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /revive <agent>');
    return;
  }
  const result = ctx.agentManager.revive(args[0]);
  if (result.error) {
    printError(result.error);
  } else {
    printSystem(`Reviving ${result.revived}...`);
  }
}

function cmdRename(ctx, args) {
  if (args.length < 2) {
    printError('Usage: /rename <agent> <newname>');
    return;
  }
  const result = ctx.agentManager.rename(args[0], args[1]);
  if (result.error) {
    printError(result.error);
  } else {
    printSystem(`Renamed ${result.renamed} → @${result.to}`);
  }
}

// ── Groups ────────────────────────────────────────────────

function cmdGroup(ctx, args) {
  if (args.length < 2) {
    printError('Usage: /group <name> <agent1> <agent2> ...');
    return;
  }
  const result = ctx.agentManager.createGroup(args[0], args.slice(1));
  if (result.error) {
    printError(result.error);
  } else {
    printSystem(`Group @${result.group}: ${result.members.join(', ')}`);
  }
}

function cmdGroups(ctx) {
  const groups = ctx.agentManager.listGroups();
  const keys = Object.keys(groups);
  if (keys.length === 0) {
    printSystem('No custom groups. Built-in: @all, @claudes, @codexes');
    return;
  }
  printSystem('Custom groups:');
  for (const [name, members] of Object.entries(groups)) {
    console.log(`  @${name}: ${members.join(', ')}`);
  }
  console.log(`  ${C.dim}Built-in: @all, @claudes, @codexes${C.reset}`);
}

function cmdUngroup(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /ungroup <name>');
    return;
  }
  const result = ctx.agentManager.removeGroup(args[0]);
  if (result.error) printError(result.error);
  else printSystem(`Removed group @${result.removed}`);
}

// ── Pinned files ──────────────────────────────────────────

function cmdPin(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /pin <filepath>');
    return;
  }
  const filePath = args.join(' ');
  if (!fs.existsSync(filePath)) {
    printError(`File not found: ${filePath}`);
    return;
  }
  ctx.session.addFileReference(filePath);
  printSystem(`📎 Pinned: ${filePath}`);
}

function cmdPins(ctx) {
  const files = [...ctx.session.filesReferenced];
  if (files.length === 0) {
    printSystem('No pinned files.');
  } else {
    printSystem('Pinned files:');
    files.forEach(f => console.log(`  📎 ${f}`));
  }
}

function cmdUnpin(ctx, args) {
  if (args.length === 0) return;
  const filePath = args.join(' ');
  ctx.session.filesReferenced.delete(filePath);
  printSystem(`Unpinned: ${filePath}`);
}

// ── Privacy & modes ───────────────────────────────────────

function cmdMode(ctx, args) {
  if (!ctx.privacy) {
    printError('Privacy module not loaded.');
    return;
  }
  if (args.length < 2) {
    printError('Usage: /mode <agent|all> <read|write>');
    return;
  }
  const target = args[0].toLowerCase();
  const mode = args[1].toLowerCase();

  if (target === 'all') {
    for (const [name] of ctx.agentManager.agents) {
      ctx.privacy.setWriteMode(name, mode === 'write');
    }
    printSystem(`All agents set to ${mode.toUpperCase()} mode`);
    return;
  }

  const resolved = ctx.agentManager.resolve(target);
  if (!resolved) {
    printError(`Agent not found: ${target}`);
    return;
  }
  ctx.privacy.setWriteMode(resolved, mode === 'write');
  printSystem(`${resolved} set to ${mode.toUpperCase()} mode`);
}

function cmdTransparent(ctx, args, value) {
  if (!ctx.privacy) return;
  if (args.length === 0) {
    printError(`Usage: /${value ? 'transparent' : 'private'} <agent>`);
    return;
  }
  const result = ctx.privacy.setTransparent(args[0], value);
  if (result.error) {
    printError(result.error);
  } else {
    printSystem(`${result.agent} is now ${value ? 'transparent (DM responses broadcast to all)' : 'private (DMs stay private until /share)'}`);
  }
}

async function cmdShare(ctx, args) {
  if (!ctx.privacy) return;
  // /share <agent> [last N | conclusion | summary | all]
  if (args.length < 1) {
    printError('Usage: /share <agent> [last N | conclusion | summary]');
    return;
  }
  const resolved = ctx.agentManager.resolve(args[0]);
  if (!resolved) {
    printError(`Agent not found: ${args[0]}`);
    return;
  }

  const mode = args[1] || 'conclusion';
  let messages;

  if (mode === 'conclusion') {
    messages = ctx.privacy.getLastPrivateMessages(resolved, 1);
  } else if (mode === 'summary') {
    messages = ctx.privacy.getPrivateLog(resolved);
  } else if (mode === 'all') {
    messages = ctx.privacy.getPrivateLog(resolved);
  } else if (mode === 'last') {
    const n = parseInt(args[2], 10) || 3;
    messages = ctx.privacy.getLastPrivateMessages(resolved, n);
  } else {
    messages = ctx.privacy.getLastPrivateMessages(resolved, 1);
  }

  if (!messages || messages.length === 0) {
    printError(`No private conversation with ${resolved} to share.`);
    return;
  }

  const formatted = ctx.privacy.formatForSharing(messages, resolved, mode);
  if (formatted) {
    ctx.session.logMessage(resolved, formatted);
    ctx.inboxManager.pushToAll(resolved, formatted, resolved);
    printSystem(`Shared ${mode} from ${resolved}'s private chat to chatroom`);
    console.log(`${C.dim}${formatted}${C.reset}`);
  }
}

// ── Focus / layout ────────────────────────────────────────

function cmdFocus(ctx, args) {
  if (args.length === 0) {
    ctx.paneManager.focusChatroom();
    return;
  }
  const resolved = ctx.agentManager.resolve(args[0]);
  if (resolved) {
    ctx.paneManager.focusPane(resolved);
  } else {
    printError(`Agent not found: ${args[0]}`);
  }
}

// ── Session ───────────────────────────────────────────────

function cmdSave(ctx) {
  const dir = ctx.session.save(ctx.agentManager, ctx.inboxManager, ctx.privacy);
  printSystem(`Session saved to: ${dir}`);
}

function cmdHistory(ctx) {
  const last10 = ctx.session.chatLog.slice(-10);
  if (last10.length === 0) {
    printSystem('No messages yet.');
    return;
  }
  printSystem('Last 10 messages:');
  for (const entry of last10) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const preview = entry.text.substring(0, 100).replace(/\n/g, ' ');
    console.log(`  ${C.dim}${time}${C.reset} ${C.bold}${entry.from}${C.reset}: ${preview}`);
  }
}

// ── Tags ──────────────────────────────────────────────────

function cmdTags(ctx, args) {
  const tags = ctx.session.searchTags(args[0] || null);
  if (tags.length === 0) {
    printSystem('No tags found.');
    return;
  }
  for (const t of tags) {
    const time = new Date(t.timestamp).toLocaleTimeString();
    console.log(`  ${C.yellow}#${t.tag}${C.reset} ${C.dim}${time}${C.reset} ${t.text.substring(0, 80)}`);
  }
}

function cmdTagAction(ctx, args) {
  if (!ctx.tagManager) return;
  if (args.length === 0) {
    printError('Usage: /tag list | /tag confirm [n] | /tag dismiss [n]');
    return;
  }

  if (args[0] === 'list') {
    const suggestions = ctx.tagManager.peekPendingSuggestions();
    if (suggestions.length === 0) {
      printSystem('No pending tag suggestions.');
      return;
    }
    printSystem('Pending tag suggestions:');
    suggestions.forEach((s, i) => {
      console.log(`  ${i + 1}. #${s.tag} (from ${s.agentName}) — ${s.text}`);
    });
    return;
  }

  if (args[0] === 'confirm') {
    const idx = args[1] ? parseInt(args[1], 10) - 1 : 0;
    const suggestions = ctx.tagManager.peekPendingSuggestions();
    if (suggestions.length === 0) {
      printSystem('No pending tag suggestions.');
      return;
    }
    const confirmed = ctx.tagManager.confirmSuggestion(idx);
    if (confirmed) {
      printSystem(`Tag confirmed: #${confirmed.tag} (suggested by ${confirmed.agentName})`);
    } else {
      printError(`Invalid index. Use /tag list to see pending suggestions.`);
    }
  } else if (args[0] === 'dismiss') {
    const idx = args[1] ? parseInt(args[1], 10) - 1 : 0;
    const dismissed = ctx.tagManager.dismissSuggestion(idx);
    if (dismissed) {
      printSystem(`Dismissed tag: #${dismissed.tag}`);
    } else {
      printSystem('No pending tag suggestions.');
    }
  }
}

// ── Tokens ────────────────────────────────────────────────

function cmdTokens(ctx) {
  if (!ctx.tokenTracker) {
    // Fallback: show byte counts
    for (const [name, pane] of ctx.paneManager.panes) {
      const kb = (pane.byteOffset / 1024).toFixed(1);
      console.log(`  ${name}: ~${kb}KB captured`);
    }
    return;
  }

  const stats = ctx.tokenTracker.allStats();
  printSystem('Token usage (estimated):');
  console.log();
  for (const s of stats) {
    const bar = progressBar(s.percent, 20);
    const color = s.percent >= 80 ? C.red : s.percent >= 50 ? C.yellow : C.green;
    console.log(`  ${s.displayName.padEnd(12)} ${color}${bar}${C.reset} ${s.tokens.toLocaleString()} / ${(s.limit/1000).toFixed(0)}k tokens (${s.percent}%)`);
    console.log(`  ${' '.repeat(12)} sent: ~${s.sent.toLocaleString()}  received: ~${s.received.toLocaleString()}`);
  }
  console.log();
}

function cmdSummarize(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /summarize <agent> — asks agent to self-summarize, then restarts with summary');
    return;
  }
  const resolved = ctx.agentManager.resolve(args[0]);
  if (!resolved) {
    printError(`Agent not found: ${args[0]}`);
    return;
  }
  // Send summarize request to agent
  ctx.inboxManager.pushTo(resolved, 'system',
    'Summarize everything we have discussed so far in a concise format. ' +
    'Include: key findings, decisions made, open questions, and current status. ' +
    'This summary will be used to continue the work in a fresh session.');
  printSystem(`Asked ${resolved} to summarize. After it responds, use /clear ${resolved} to restart it with the summary.`);
}

async function cmdClear(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /clear <agent> — restart agent session, seed with last summary');
    return;
  }
  const resolved = ctx.agentManager.resolve(args[0]);
  if (!resolved) {
    printError(`Agent not found: ${args[0]}`);
    return;
  }

  // Grab the last response from this agent as the summary
  const lastResponse = ctx.session.chatLog.filter(e => e.from === resolved).pop();
  const summary = lastResponse ? lastResponse.text : null;

  // Clear stale inbox before restarting (prevents processing old queued messages)
  ctx.inboxManager.clear(resolved);

  // Revive the agent (restarts its CLI session, truncates log file)
  const result = ctx.agentManager.revive(resolved);
  if (result.error) {
    printError(result.error);
    return;
  }

  // Reset token tracking
  if (ctx.tokenTracker) {
    ctx.tokenTracker.sent[resolved] = 0;
    ctx.tokenTracker.received[resolved] = 0;
  }

  // Wait for agent to start up
  const agent = ctx.agentManager.agents.get(resolved);
  const provider = ctx.agentManager.providers[agent.provider];
  printSystem(`Restarting ${resolved}...`);
  await new Promise(r => setTimeout(r, provider.startupDelay));
  ctx.agentManager.setStatus(resolved, 'idle');

  // Seed with summary if available
  if (summary) {
    ctx.inboxManager.pushTo(resolved, 'system',
      `[Previous session summary]\n${summary}\n[End of summary — fresh session started]`);
    printSystem(`${resolved} restarted and seeded with summary. @${resolved} to continue.`);
  } else {
    printSystem(`${resolved} restarted with clean slate.`);
  }
}

// ── Display helpers ───────────────────────────────────────

function cmdFull(ctx, args) {
  if (args.length === 0) {
    printError('Usage: /full <agent> — show full last response');
    return;
  }
  const resolved = ctx.agentManager.resolve(args[0]);
  if (!resolved) {
    printError(`Agent not found: ${args[0]}`);
    return;
  }
  const lastResponse = ctx.session.chatLog.filter(e => e.from === resolved).pop();
  if (lastResponse) {
    printAgent(ctx.agentManager.displayName(resolved) + ' (full)', lastResponse.text, ctx.agentManager.agents.get(resolved)?.provider);
  } else {
    printSystem(`No responses from ${resolved} yet.`);
  }
}

function cmdStatus(ctx) {
  // Combined status view
  const agents = ctx.agentManager.list();
  console.log();
  for (const a of agents) {
    const statusColor = a.status === 'idle' ? C.green
      : a.status === 'running' ? C.yellow
      : a.status === 'dead' ? C.red : C.dim;

    let extra = '';
    if (ctx.privacy) {
      if (ctx.privacy.isTransparent(a.name)) extra += ' [transparent]';
      if (ctx.privacy.hasWriteMode(a.name)) extra += ` ${C.red}[WRITE]${C.reset}`;
    }
    if (ctx.tokenTracker) {
      const pct = ctx.tokenTracker.usagePercent(a.name);
      extra += ` ctx:${pct}%`;
    }

    console.log(`  ${statusColor}◉${C.reset} ${a.displayName.padEnd(12)} [${a.provider}] ${statusColor}${a.status.padEnd(8)}${C.reset} inbox:${a.inbox}${extra}`);
  }
  if (ctx.tokenTracker) {
    console.log();
    console.log(`  ${C.dim}${ctx.tokenTracker.statusBar()}${C.reset}`);
  }
  console.log();
}

function cmdPreset(ctx) {
  if (!ctx.workflows) return;
  const presets = ctx.workflows.listPresets();
  printSystem('Available workflows:');
  for (const p of presets) {
    console.log(`  ${p.name} — ${p.description}`);
  }
}

// ── Help ──────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
${C.bold}${C.cyan}=== agent-ceo v2.0 ===${C.reset}

${C.bold}Addressing:${C.reset}
  @agent message        Talk to one agent
  @all message          All agents respond
  @claudes / @codexes   Provider groups
  @mygroup message      Custom group
  @agent:stop           Stop mid-response
  @agent:write msg      One-time write permission
  @agent:dm msg         Private DM (others won't see)
  plain text            Queued silently for all

${C.bold}Agents:${C.reset}
  /agents  /spawn  /kill  /revive  /rename  /status  /clear

${C.bold}Groups:${C.reset}
  /group <name> a1 a2   Create    /ungroup  /groups

${C.bold}Privacy & Modes:${C.reset}
  /dm <agent> <msg>          Private DM (same as @agent:dm)
  /mode <agent> write|read   Persistent write toggle
  /transparent <agent>       DM responses also broadcast
  /private <agent>           DM stays private until /share
  /share <agent> [mode]      Share private to chatroom
    modes: conclusion, summary, last N, all

${C.bold}Workflows:${C.reset}
  /debate [agents] [topic]   Cross-critique
  /plan <a1> <a2> <topic>    Architect + critic
  /review <a1> <a2> <task>   Implement + review
  /research [agents] <topic> Parallel investigation
  /preset                    List available workflows

${C.bold}Files:${C.reset}  /pin  /unpin  /pins

${C.bold}Tags:${C.reset}
  #decision #todo #rejected  Manual tags in messages
  /tags [filter]             Search tags
  /tag list                  Show pending suggestions
  /tag confirm [n]           Confirm suggestion
  /tag dismiss [n]           Dismiss suggestion

${C.bold}Session:${C.reset}
  /session name <n>  /save  /history  /tokens
  /summarize <agent>  /clear <agent>  /full <agent>

${C.bold}Layout:${C.reset}  /focus [agent]   /layout

${C.bold}Other:${C.reset}   /help   /quit
`);
}

module.exports = {
  cmdAgents,
  cmdSpawn,
  cmdKill,
  cmdRevive,
  cmdRename,
  cmdGroup,
  cmdGroups,
  cmdUngroup,
  cmdPin,
  cmdPins,
  cmdUnpin,
  cmdMode,
  cmdTransparent,
  cmdShare,
  cmdFocus,
  cmdSave,
  cmdHistory,
  cmdTags,
  cmdTagAction,
  cmdTokens,
  cmdSummarize,
  cmdClear,
  cmdFull,
  cmdStatus,
  cmdPreset,
  cmdHelp,
};
