/**
 * @typedef {Object} Project
 * @property {string} id
 * @property {string} [name]
 * @property {string} [path]
 * @property {string} [stack]
 * @property {string} [color]
 * @property {string} [devCmd]
 * @property {string} [github]
 */

/**
 * @typedef {Object} JiraConfig
 * @property {string} [url]
 * @property {string} [email]
 * @property {string} [apiToken]
 */

/**
 * @typedef {Object} AiConfig
 * @property {string} [geminiApiKey]
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const HOME = homedir().replace(/\\/g, '/');
const __dirname = dirname(fileURLToPath(import.meta.url));

export const CLAUDE_DIR = `${HOME}/.claude`;
export const CLAUDE_PROJECTS_DIR = `${CLAUDE_DIR}/projects`;
export const STATS_CACHE_PATH = `${CLAUDE_DIR}/stats-cache.json`;
export const HISTORY_PATH = `${CLAUDE_DIR}/history.jsonl`;

// ─── Data directory: %LOCALAPPDATA%/cockpit (survives reinstall) ───
const APPDATA = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), '.local', 'share');
export const DATA_DIR = join(APPDATA, 'cockpit');
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* dir may already exist */ }

// Migrate a file from old install-dir location to new DATA_DIR
function migrateFile(filename) {
  const oldPath = join(__dirname, '..', filename);
  const newPath = join(DATA_DIR, filename);
  if (!existsSync(newPath) && existsSync(oldPath)) {
    try { copyFileSync(oldPath, newPath); } catch { /* best-effort migration */ }
  }
  return newPath;
}

const PROJECTS_FILE = migrateFile('projects.json');
const JIRA_CONFIG_FILE = migrateFile('jira-config.json');
const AI_CONFIG_FILE = migrateFile('ai-config.json');

// ─── 설정 파일 자동 백업 (덮어쓰기 전 이전 버전 보존, 파일당 최대 10개) ───
const BACKUP_DIR = join(DATA_DIR, 'backups');
const BACKUP_KEEP = 10;

function backupConfigFile(filePath) {
  try {
    if (!existsSync(filePath)) return;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const base = filePath.split('/').pop();
    copyFileSync(filePath, join(BACKUP_DIR, `${base}.${Date.now()}.bak`));
    const backups = readdirSync(BACKUP_DIR)
      .filter(name => name.startsWith(`${base}.`) && name.endsWith('.bak'))
      .sort();
    for (const stale of backups.slice(0, Math.max(0, backups.length - BACKUP_KEEP))) {
      try { unlinkSync(join(BACKUP_DIR, stale)); } catch { /* best-effort */ }
    }
  } catch { /* 백업 실패는 저장을 막지 않음 */ }
}

const COLOR_PALETTE = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EF4444', '#EC4899', '#06B6D4', '#84CC16',
  '#F97316', '#6366F1', '#14B8A6', '#E11D48'
];

/**
 * Generate a deterministic color from a project name.
 * @param {string} name
 * @returns {string} Hex color code
 */
export function generateColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

const ALLOWED_FIELDS = ['name', 'path', 'stack', 'color', 'devCmd', 'github'];

function loadProjectsFile() {
  try {
    if (!existsSync(PROJECTS_FILE)) return { projects: [] };
    const data = JSON.parse(readFileSync(PROJECTS_FILE, 'utf8'));
    const before = data.projects?.length || 0;
    data.projects = (data.projects || [])
      .filter(p => p.path && existsSync(p.path))
      .map(p => {
        const id = p.id || p.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
          || `project-${Date.now().toString(36)}`;
        const clean = { id };
        for (const k of ALLOWED_FIELDS) { if (p[k] !== undefined) clean[k] = p[k]; }
        return clean;
      });
    if (data.projects.length < before) {
      console.log(`[Config] Removed ${before - data.projects.length} projects with missing paths`);
    }
    return data;
  } catch { return { projects: [] }; }
}

// M10: Atomic write with rename to prevent race condition corruption
let _saveQueued = false;
function saveProjectsFile(data) {
  if (_saveQueued) return; // coalesce rapid saves
  _saveQueued = true;
  queueMicrotask(() => {
    _saveQueued = false;
    backupConfigFile(PROJECTS_FILE);
    const tmp = PROJECTS_FILE + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, PROJECTS_FILE);
    } catch (err) {
      console.error('[Config] Save error:', err.message);
      try { unlinkSync(tmp); } catch { /* tmp already removed */ }
    }
  });
}

const _data = loadProjectsFile();

/** @returns {Project[]} */
export function getProjects() {
  return _data.projects;
}

/**
 * @param {string} id
 * @returns {Project | undefined}
 */
export function getProjectById(id) {
  return _data.projects.find(p => p.id === id);
}

/**
 * @param {Partial<Project> & { name: string }} project
 * @returns {Project}
 */
export function addProject(project) {
  let id = project.id || project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    || `project-${Date.now().toString(36)}`;
  // Ensure unique ID
  const existingIds = new Set(_data.projects.map(p => p.id));
  if (existingIds.has(id)) {
    let suffix = 2;
    while (existingIds.has(`${id}-${suffix}`)) suffix++;
    id = `${id}-${suffix}`;
  }
  const clean = { id };
  for (const k of ALLOWED_FIELDS) { if (project[k] !== undefined) clean[k] = project[k]; }
  // Validate color to prevent CSS injection
  if (clean.color && !/^#[0-9a-fA-F]{3,8}$/.test(clean.color)) delete clean.color;
  if (!clean.color) clean.color = generateColor(clean.name);
  _data.projects.push(clean);
  saveProjectsFile(_data);
  return clean;
}

/**
 * @param {string} id
 * @param {Partial<Project>} updates
 * @returns {Project | null}
 */
export function updateProject(id, updates) {
  const idx = _data.projects.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const clean = {};
  for (const k of ALLOWED_FIELDS) { if (updates[k] !== undefined) clean[k] = updates[k]; }
  if (clean.color && !/^#[0-9a-fA-F]{3,8}$/.test(clean.color)) delete clean.color;
  _data.projects[idx] = { ..._data.projects[idx], ...clean, id };
  saveProjectsFile(_data);
  return _data.projects[idx];
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function deleteProject(id) {
  const idx = _data.projects.findIndex(p => p.id === id);
  if (idx === -1) return false;
  _data.projects.splice(idx, 1);
  saveProjectsFile(_data);
  return true;
}

export const POLL_INTERVALS = {
  sessionStatus: 5000,
  gitStatus: 30000,
  prStatus: 120000,
  costData: 60000,
  activity: 10000
};

export const PORT = parseInt(process.env.COCKPIT_PORT, 10) || 3847;

// ─── Limits & Thresholds (centralized to avoid magic numbers) ───
export const LIMITS = {
  jsonBodyBytes: 10 * 1024 * 1024,       // 10MB — max JSON request body
  imageUploadBytes: 10 * 1024 * 1024,     // 10MB — max image upload
  filePreviewBytes: 2 * 1024 * 1024,      // 2MB — max file preview
  fileWriteBytes: 500 * 1024,             // 500KB — max file write (Forge)
  terminalBuffer: 50000,                  // 50KB — terminal output rolling buffer
  claudeTimeoutMs: 60000,                 // 60s — Claude CLI timeout
  diffMaxChars: 15000,                    // diff truncation (commit msg)
  diffMaxLines: 3000,                     // diff line limit (viewer)
  autoCommitDiffChars: 20000,             // auto-commit plan diff limit
  gitLogDefault: 30,                      // default git log entries
  gitLogMax: 100,                         // max git log entries
  terminalMaxAge: 24 * 60 * 60 * 1000,   // 24h — terminal state restore limit
  cmdMaxLength: 500,                      // max command string length
};

// ─── Token Encryption (AES-256-GCM, per-install random key) ───
const KEY_FILE = join(DATA_DIR, '.encryption-key');

function deriveKey() {
  // C6: Use a random 32-byte key stored on first run, NOT hostname/username
  try {
    if (existsSync(KEY_FILE)) {
      return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    }
  } catch { /* key file not found, will generate new */ }
  // Generate and persist a new random key
  const key = randomBytes(32);
  try { writeFileSync(KEY_FILE, key.toString('hex'), 'utf8'); } catch { /* non-critical: key stays in memory */ }
  return key;
}

function encryptToken(plaintext) {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(encrypted) {
  if (!encrypted.startsWith('enc:')) return encrypted; // plaintext fallback
  const [, ivHex, tagHex, encHex] = encrypted.split(':');
  const key = deriveKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

// ─── Jira Config ───
/** @returns {JiraConfig | null} */
export function getJiraConfig() {
  try {
    if (!existsSync(JIRA_CONFIG_FILE)) return null;
    const config = JSON.parse(readFileSync(JIRA_CONFIG_FILE, 'utf8'));
    // Decrypt token on read
    if (config?.apiToken) {
      try { config.apiToken = decryptToken(config.apiToken); } catch { /* key mismatch = keep as-is */ }
    }
    return config;
  } catch { return null; }
}

/** @param {JiraConfig} config */
export function saveJiraConfig(config) {
  backupConfigFile(JIRA_CONFIG_FILE);
  const toSave = { ...config };
  // Encrypt token before saving
  if (toSave.apiToken && !toSave.apiToken.startsWith('enc:')) {
    toSave.apiToken = encryptToken(toSave.apiToken);
  }
  writeFile(JIRA_CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8')
    .catch(err => console.error('[Config] Jira save error:', err.message));
}

// ─── AI Config (Gemini API key etc.) ───
/** @returns {AiConfig | null} */
export function getAiConfig() {
  try {
    if (!existsSync(AI_CONFIG_FILE)) return null;
    const config = JSON.parse(readFileSync(AI_CONFIG_FILE, 'utf8'));
    if (config?.geminiApiKey) {
      try { config.geminiApiKey = decryptToken(config.geminiApiKey); } catch { /* decryption failed, key may be plaintext */ }
    }
    return config;
  } catch { return null; }
}

/** @param {AiConfig} config */
export function saveAiConfig(config) {
  backupConfigFile(AI_CONFIG_FILE);
  const toSave = { ...config };
  if (toSave.geminiApiKey && !toSave.geminiApiKey.startsWith('enc:')) {
    toSave.geminiApiKey = encryptToken(toSave.geminiApiKey);
  }
  writeFile(AI_CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf8')
    .catch(err => console.error('[Config] AI config save error:', err.message));
}

/**
 * Convert a project path to Claude Code's encoded project directory name.
 * @param {string} projectPath
 * @returns {string}
 */
export function toClaudeProjectDir(projectPath) {
  // Claude Code encodes project paths by replacing all non-alphanumeric chars with '-'
  // Drive letter casing varies (C or c), so we try both in getProjectJsonlDir
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}
