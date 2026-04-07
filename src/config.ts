import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'GEMINI_API_KEY',
  'GEMINI_PRIMARY_MODEL',
  'GEMINI_FAST_MODEL',
  'GEMINI_THINKING_BUDGET',
  'GEMINI_CACHE_TTL_SECONDS',
  'YOUTUBE_API_KEY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Sergey';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoflash',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoflash',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Gemini configuration
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY || envConfig.GEMINI_API_KEY || '';
export const GEMINI_PRIMARY_MODEL =
  process.env.GEMINI_PRIMARY_MODEL ||
  envConfig.GEMINI_PRIMARY_MODEL ||
  'gemini-2.5-flash';
export const GEMINI_FAST_MODEL =
  process.env.GEMINI_FAST_MODEL ||
  envConfig.GEMINI_FAST_MODEL ||
  'gemini-2.5-flash';
export const MAX_TOOL_ROUNDS = parseInt(
  process.env.MAX_TOOL_ROUNDS || '25',
  10,
);
// -1 = dynamic (model decides), 0 = disabled, 1–24576 = fixed token budget
export const GEMINI_THINKING_BUDGET = parseInt(
  process.env.GEMINI_THINKING_BUDGET ||
    envConfig.GEMINI_THINKING_BUDGET ||
    '-1',
  10,
);
export const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY || envConfig.YOUTUBE_API_KEY || '';

export const GEMINI_CACHE_TTL_SECONDS = parseInt(
  process.env.GEMINI_CACHE_TTL_SECONDS ||
    envConfig.GEMINI_CACHE_TTL_SECONDS ||
    '3600',
  10,
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoflash-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
// If a container has been alive longer than MAX_SESSION_AGE_MS, the idle
// timeout drops to SESSION_IDLE_TIMEOUT_MS so stale long-running sessions
// don't accumulate unbounded context.
export const MAX_SESSION_AGE_MS = 60 * 60 * 1000; // 1 hour
export const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
