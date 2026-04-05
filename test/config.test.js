const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const Config = require('../src/config');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
}

describe('Config', () => {
  let dir;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('load returns defaults when no config file exists', () => {
    const config = Config.load(dir);
    assert.strictEqual(config.agentsPerWindow, 4);
    assert.strictEqual(config.focusOnJoin, true);
    assert.deepStrictEqual(config.providersOrder, ['claude', 'codex']);
  });

  test('load merges config.json over defaults', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agentsPerWindow: 6 }));
    const config = Config.load(dir);
    assert.strictEqual(config.agentsPerWindow, 6);
    assert.strictEqual(config.focusOnJoin, true);
  });

  test('load throws ConfigParseError on invalid JSON', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), 'NOT{JSON');
    assert.throws(() => Config.load(dir), (err) => err.code === 'CONFIG_PARSE_ERROR');
  });

  test('save writes config.json', () => {
    Config.save(dir, { agentsPerWindow: 8 });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    assert.strictEqual(raw.agentsPerWindow, 8);
  });

  test('loadDefaults returns empty object when no defaults.json', () => {
    const defaults = Config.loadDefaults(dir);
    assert.deepStrictEqual(defaults, {});
  });

  test('saveDefaults writes per-project team defaults', () => {
    Config.saveDefaults(dir, '/my/project', { claude: 3, codex: 1 });
    const defaults = Config.loadDefaults(dir);
    assert.deepStrictEqual(defaults['/my/project'], { claude: 3, codex: 1 });
  });

  test('saveDefaults preserves existing project entries', () => {
    Config.saveDefaults(dir, '/project-a', { claude: 2 });
    Config.saveDefaults(dir, '/project-b', { codex: 3 });
    const defaults = Config.loadDefaults(dir);
    assert.deepStrictEqual(defaults['/project-a'], { claude: 2 });
    assert.deepStrictEqual(defaults['/project-b'], { codex: 3 });
  });

  test('resetConfig backs up bad file and writes defaults', () => {
    fs.writeFileSync(path.join(dir, 'config.json'), 'BROKEN');
    Config.resetConfig(dir);
    const backups = fs.readdirSync(dir).filter(f => f.startsWith('config.json.bad-'));
    assert.strictEqual(backups.length, 1);
    const config = Config.load(dir);
    assert.strictEqual(config.agentsPerWindow, 4);
  });
});
