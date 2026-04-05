const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectProjectDir, buildSessionLabel, writeMeta, readMeta } = require('../src/menu');

describe('Menu utilities', () => {
  test('detectProjectDir returns git root when in a git repo', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
    const subDir = path.join(tmpRepo, 'sub');
    fs.mkdirSync(subDir);
    require('child_process').execSync('git init', { cwd: tmpRepo, stdio: 'ignore' });
    const result = detectProjectDir(subDir);
    assert.strictEqual(fs.realpathSync(result), fs.realpathSync(tmpRepo));
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test('detectProjectDir returns cwd when not in a git repo', () => {
    const tmpNoGit = fs.mkdtempSync(path.join(os.tmpdir(), 'nogit-test-'));
    const result = detectProjectDir(tmpNoGit);
    assert.strictEqual(result, tmpNoGit);
    fs.rmSync(tmpNoGit, { recursive: true, force: true });
  });

  test('buildSessionLabel uses custom name first', () => {
    const label = buildSessionLabel({ customName: 'my-project', projectDir: '/foo/bar', gitRepoName: 'bar' });
    assert.strictEqual(label, 'my-project');
  });

  test('buildSessionLabel falls back to git repo name', () => {
    const label = buildSessionLabel({ customName: null, projectDir: '/foo/bar', gitRepoName: 'bar' });
    assert.strictEqual(label, 'bar');
  });

  test('buildSessionLabel falls back to cwd basename', () => {
    const label = buildSessionLabel({ customName: null, projectDir: '/foo/my-dir', gitRepoName: null });
    assert.strictEqual(label, 'my-dir');
  });
});

describe('Meta.json', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writeMeta creates meta.json atomically', () => {
    writeMeta(dir, { label: 'test', team: {} });
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
    assert.strictEqual(meta.label, 'test');
  });

  test('readMeta returns null if no meta.json', () => {
    assert.strictEqual(readMeta(dir), null);
  });

  test('readMeta returns parsed meta', () => {
    writeMeta(dir, { label: 'hello', projectDir: '/test' });
    const meta = readMeta(dir);
    assert.strictEqual(meta.label, 'hello');
    assert.strictEqual(meta.projectDir, '/test');
  });
});
