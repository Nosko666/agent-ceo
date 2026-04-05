const fs = require('fs');
const path = require('path');

const BUILT_IN_DEFAULTS = {
  agentsPerWindow: 4,
  focusOnJoin: true,
  providersOrder: ['claude', 'codex'],
  codexSessionsDir: null,
  runtimeDir: null,
};

class ConfigParseError extends Error {
  constructor(filePath, cause) {
    super(`Invalid JSON in ${filePath}: ${cause.message}`);
    this.code = 'CONFIG_PARSE_ERROR';
    this.filePath = filePath;
    this.cause = cause;
  }
}

function load(baseDir) {
  const configPath = path.join(baseDir, 'config.json');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try { userConfig = JSON.parse(raw); }
    catch (e) { throw new ConfigParseError(configPath, e); }
  }
  return { ...BUILT_IN_DEFAULTS, ...userConfig };
}

function save(baseDir, config) {
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

function loadDefaults(baseDir) {
  const defaultsPath = path.join(baseDir, 'defaults.json');
  if (!fs.existsSync(defaultsPath)) return {};
  try { return JSON.parse(fs.readFileSync(defaultsPath, 'utf-8')); }
  catch { return {}; }
}

function saveDefaults(baseDir, projectDir, teamSpec) {
  const defaultsPath = path.join(baseDir, 'defaults.json');
  const existing = loadDefaults(baseDir);
  existing[projectDir] = teamSpec;
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(defaultsPath, JSON.stringify(existing, null, 2) + '\n');
}

function resetConfig(baseDir) {
  const configPath = path.join(baseDir, 'config.json');
  if (fs.existsSync(configPath)) {
    const backupName = `config.json.bad-${Date.now()}`;
    fs.renameSync(configPath, path.join(baseDir, backupName));
  }
  save(baseDir, BUILT_IN_DEFAULTS);
}

module.exports = { load, save, loadDefaults, saveDefaults, resetConfig, BUILT_IN_DEFAULTS, ConfigParseError };
