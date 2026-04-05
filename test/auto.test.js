const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const AutoRunner = require('../src/auto');

describe('AutoRunner', () => {
  describe('role assignment', () => {
    test('assigns deterministic roles with 3+ agents', () => {
      const roles = AutoRunner.assignRoles(['claude1', 'claude2', 'codex1']);
      assert.strictEqual(roles.planner, 'claude1');
      assert.strictEqual(roles.implementer, 'claude1');
      assert.strictEqual(roles.reviewer, 'codex1');
      assert.deepStrictEqual(roles.critics, ['claude2', 'codex1']);
    });

    test('assigns roles with 2 agents', () => {
      const roles = AutoRunner.assignRoles(['claude1', 'codex1']);
      assert.strictEqual(roles.planner, 'claude1');
      assert.strictEqual(roles.reviewer, 'codex1');
      assert.deepStrictEqual(roles.critics, ['codex1']);
    });

    test('solo mode with 1 agent', () => {
      const roles = AutoRunner.assignRoles(['claude1']);
      assert.strictEqual(roles.planner, 'claude1');
      assert.strictEqual(roles.implementer, 'claude1');
      assert.strictEqual(roles.reviewer, 'claude1');
      assert.strictEqual(roles.solo, true);
    });

    test('override roles', () => {
      const roles = AutoRunner.assignRoles(['claude1', 'claude2', 'codex1'], {
        planner: 'codex1',
        reviewer: 'claude2',
      });
      assert.strictEqual(roles.planner, 'codex1');
      assert.strictEqual(roles.reviewer, 'claude2');
    });

    test('no-roles mode', () => {
      const roles = AutoRunner.assignRoles(['claude1', 'claude2'], { noRoles: true });
      assert.strictEqual(roles.planner, null);
      assert.strictEqual(roles.reviewer, null);
      assert.strictEqual(roles.noRoles, true);
    });

    test('--critic override with comma-separated list', () => {
      const roles = AutoRunner.assignRoles(['claude1', 'claude2', 'codex1'], {
        critic: ['claude2', 'codex1'],
      });
      assert.deepStrictEqual(roles.critics, ['claude2', 'codex1']);
    });
  });

  describe('pipeline validation', () => {
    test('validates known steps', () => {
      assert.doesNotThrow(() => AutoRunner.validatePipeline(['plan', 'debate', 'consensus']));
    });

    test('rejects unknown steps', () => {
      assert.throws(() => AutoRunner.validatePipeline(['plan', 'magic']), /unknown.*step.*magic/i);
    });

    test('default pipeline is valid', () => {
      assert.doesNotThrow(() => AutoRunner.validatePipeline(AutoRunner.DEFAULT_PIPELINE));
    });
  });

  describe('consensus parsing', () => {
    test('detects CONSENSUS: YES', () => {
      const result = AutoRunner.parseConsensus('Some text\nCONSENSUS: YES');
      assert.strictEqual(result.vote, 'YES');
      assert.strictEqual(result.blockers, null);
    });

    test('detects CONSENSUS: NO with blockers', () => {
      const result = AutoRunner.parseConsensus('Analysis...\nCONSENSUS: NO\nBLOCKERS: Missing auth handling');
      assert.strictEqual(result.vote, 'NO');
      assert.strictEqual(result.blockers, 'Missing auth handling');
    });

    test('returns null for missing token', () => {
      assert.strictEqual(AutoRunner.parseConsensus('No markers here'), null);
    });
  });

  describe('review parsing', () => {
    test('detects REVIEW: APPROVE', () => {
      const result = AutoRunner.parseReview('Good code\nREVIEW: APPROVE');
      assert.strictEqual(result.decision, 'APPROVE');
    });

    test('detects REVIEW: REQUEST_CHANGES with reason', () => {
      const result = AutoRunner.parseReview('Issues\nREVIEW: REQUEST_CHANGES — missing validation');
      assert.strictEqual(result.decision, 'REQUEST_CHANGES');
      assert.ok(result.feedback.includes('missing validation'));
    });

    test('returns null for missing token', () => {
      assert.strictEqual(AutoRunner.parseReview('No markers'), null);
    });
  });

  describe('plan format parsing', () => {
    test('extracts PLAN_SUMMARY and ACCEPTANCE_CRITERIA', () => {
      const text = 'PLAN:\nDetailed\n\nPLAN_SUMMARY:\n- Item 1\n- Item 2\n\nACCEPTANCE_CRITERIA:\n- Tests pass';
      const result = AutoRunner.parsePlanFormat(text);
      assert.ok(result.planSummary.includes('Item 1'));
      assert.ok(result.acceptanceCriteria.includes('Tests pass'));
    });

    test('returns null for missing sections', () => {
      assert.strictEqual(AutoRunner.parsePlanFormat('Just text'), null);
    });
  });

  describe('state machine', () => {
    test('initial state is idle', () => {
      const runner = new AutoRunner();
      assert.strictEqual(runner.state, 'idle');
    });

    test('job starts in running state', () => {
      const runner = new AutoRunner();
      const job = runner.createJob({ goal: 'Build API', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      assert.strictEqual(job.state, 'running');
      assert.strictEqual(job.id, 1);
    });

    test('rejects second job while running', () => {
      const runner = new AutoRunner();
      runner.createJob({ goal: 'A', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      assert.throws(() => runner.createJob({ goal: 'B', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 }), /already/i);
    });

    test('pause and resume', () => {
      const runner = new AutoRunner();
      runner.createJob({ goal: 'A', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      runner.pause('manual');
      assert.strictEqual(runner.state, 'paused');
      runner.resume();
      assert.strictEqual(runner.state, 'running');
    });

    test('stop transitions to idle', () => {
      const runner = new AutoRunner();
      runner.createJob({ goal: 'A', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      runner.stop();
      assert.strictEqual(runner.state, 'idle');
    });

    test('job IDs are monotonic', () => {
      const runner = new AutoRunner();
      const j1 = runner.createJob({ goal: 'A', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      runner.stop();
      const j2 = runner.createJob({ goal: 'B', pipeline: ['plan'], participants: ['claude1'], maxRounds: 10, maxTimeMs: 1800000 });
      assert.strictEqual(j1.id, 1);
      assert.strictEqual(j2.id, 2);
    });
  });

  describe('compact output', () => {
    test('formats normal response', () => {
      const line = AutoRunner.formatCompact({ round: 3, maxRounds: 10, step: 'debate', agentName: 'claude1', text: 'I think the architecture needs microservices', tokenEstimate: 183 });
      assert.ok(line.includes('Round 3/10'));
      assert.ok(line.includes('debate'));
      assert.ok(line.includes('claude1'));
    });

    test('formats consensus token', () => {
      const line = AutoRunner.formatCompact({ round: 5, maxRounds: 10, step: 'consensus', agentName: 'codex1', text: 'Agreed\nCONSENSUS: YES', tokenEstimate: 50 });
      assert.ok(line.includes('CONSENSUS: YES'));
    });

    test('formats review token', () => {
      const line = AutoRunner.formatCompact({ round: 7, maxRounds: 10, step: 'review', agentName: 'codex1', text: 'Issues\nREVIEW: REQUEST_CHANGES — add validation', tokenEstimate: 120 });
      assert.ok(line.includes('REVIEW: REQUEST_CHANGES'));
    });
  });
});
