import { concatHex, createPublicClient, createWalletClient, formatEther, http, numberToHex, parseAbi, parseEther, stringToHex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import cron from 'node-cron';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();


const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0xeC6AF3c5934F383972bb9980A51EC976099270b8';
const ARENA_CONTRACT_ADDRESS = process.env.ARENA_CONTRACT_ADDRESS || '0x09C1FaD72f10c0Dd4C083A28990Faa8A7C8F0580';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AGENT_PRIVATE_KEYS = (process.env.AGENT_PRIVATE_KEYS || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);
const AGENT_NAMES = (process.env.AGENT_NAMES || '')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
const ARENA_ENABLED = String(process.env.ARENA_ENABLED || 'false').toLowerCase() === 'true';
const ARENA_AGENTS_COUNT = process.env.ARENA_AGENTS_COUNT
  ? Math.max(0, Number(process.env.ARENA_AGENTS_COUNT) || 0)
  : Number.MAX_SAFE_INTEGER;
const ARENA_CHARACTERS = (process.env.ARENA_CHARACTERS || 'trump,vitalik,satoshi')
  .split(',')
  .map(characterId => characterId.trim())
  .filter(Boolean);
const ARENA_DAILY_TX_MIN = Math.max(0, Number(process.env.ARENA_DAILY_TX_MIN || 4));
const ARENA_DAILY_TX_MAX = Math.max(ARENA_DAILY_TX_MIN, Number(process.env.ARENA_DAILY_TX_MAX || 5));
const ARENA_ACTION_DELAY_MIN_MS = Math.max(0, Number(process.env.ARENA_ACTION_DELAY_MIN_MS || 2000));
const ARENA_ACTION_DELAY_MAX_MS = Math.max(
  ARENA_ACTION_DELAY_MIN_MS,
  Number(process.env.ARENA_ACTION_DELAY_MAX_MS || 5000)
);
const ARENA_DEBUG_LOGS = String(process.env.ARENA_DEBUG_LOGS || 'true').toLowerCase() === 'true';
const AGENT_RUN_STAGGER_MS = Math.max(0, Number(process.env.AGENT_RUN_STAGGER_MS || 3000));
const LOG_AGENT_SKIPS = String(process.env.LOG_AGENT_SKIPS || 'false').toLowerCase() === 'true';
const LOG_AGENT_ADDRESSES = String(process.env.LOG_AGENT_ADDRESSES || 'false').toLowerCase() === 'true';
const LOG_AGENT_STAGGER_WAIT = String(process.env.LOG_AGENT_STAGGER_WAIT || 'false').toLowerCase() === 'true';
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const FARCASTER_SIGNER_UUID = process.env.FARCASTER_SIGNER_UUID;
const FARCASTER_POSTS_ENABLED = String(process.env.FARCASTER_POSTS_ENABLED || 'false').toLowerCase() === 'true';
const APP_URL = process.env.APP_URL || 'https://rate-slayer.vercel.app';
const BASE_RPC_URL_READ = process.env.BASE_RPC_URL_READ || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const BASE_RPC_URL_WRITE = process.env.BASE_RPC_URL_WRITE || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 5);
const RPC_BASE_DELAY_MS = Number(process.env.RPC_BASE_DELAY_MS || 500);
const RPC_MAX_DELAY_MS = Number(process.env.RPC_MAX_DELAY_MS || 8000);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 200);
const AGENT_RANDOM_SKIP_CHANCE = Math.min(
  0.95,
  Math.max(0, Number(process.env.AGENT_RANDOM_SKIP_CHANCE || 0.35))
);
const AGENT_ACTION_DELAY_MIN_MS = Math.max(0, Number(process.env.AGENT_ACTION_DELAY_MIN_MS || 15000));
const AGENT_ACTION_DELAY_MAX_MS = Math.max(
  AGENT_ACTION_DELAY_MIN_MS,
  Number(process.env.AGENT_ACTION_DELAY_MAX_MS || 180000)
);
const AGENT_MIN_BALANCE_ETH = process.env.AGENT_MIN_BALANCE_ETH || '0.000001';
const AGENT_NEW_ACTION_CHANCE = Math.min(
  1,
  Math.max(0, Number(process.env.AGENT_NEW_ACTION_CHANCE || 0.9))
);
const AGENT_ACTION_CHANCE_DAILY_DECAY = Math.min(
  1,
  Math.max(0.9, Number(process.env.AGENT_ACTION_CHANCE_DAILY_DECAY || 0.985))
);
const AGENT_MIN_ACTION_CHANCE = Math.min(
  1,
  Math.max(0, Number(process.env.AGENT_MIN_ACTION_CHANCE || 0.2))
);
const AGENT_CYCLE_MAX_TRANSACTIONS = Math.max(1, Number(process.env.AGENT_CYCLE_MAX_TRANSACTIONS || 2));
const AGENT_DAILY_TX_MIN = Math.max(1, Number(process.env.AGENT_DAILY_TX_MIN || 15));
const AGENT_DAILY_TX_MAX = Math.max(AGENT_DAILY_TX_MIN, Number(process.env.AGENT_DAILY_TX_MAX || 20));
const AGENT_NEW_PRIORITY_DAYS = Math.max(0, Number(process.env.AGENT_NEW_PRIORITY_DAYS || 7));
const RUN_ON_START = String(process.env.RUN_ON_START || 'false').toLowerCase() === 'true';
const AGENT_STATE_FILE = process.env.AGENT_STATE_FILE || '.agent-state.json';
const BUILDER_CODE = process.env.BUILDER_CODE?.trim();
const BUILDER_CODES = (process.env.BUILDER_CODES || '')
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
const BUILDER_DATA_SUFFIX = process.env.BUILDER_DATA_SUFFIX?.trim();
const ARENA_BUILDER_CODE = process.env.ARENA_BUILDER_CODE?.trim();
const ARENA_BUILDER_CODES = (process.env.ARENA_BUILDER_CODES || '')
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
const ARENA_BUILDER_DATA_SUFFIX = process.env.ARENA_BUILDER_DATA_SUFFIX?.trim();
const ERC8021_DATA_SUFFIX = '0x80218021802180218021802180218021';
const FARCASTER_MAX_SUCCESS_POSTS_PER_DAY = 1;
const CAST_PERSONAS = ['Atlas', 'Rook', 'Mantis', 'Viper', 'Nova', 'Sentinel', 'Cipher', 'Falcon'];
const DAY_MS = 24 * 60 * 60 * 1000;
let AGENT_MIN_BALANCE_WEI;
try {
  AGENT_MIN_BALANCE_WEI = parseEther(AGENT_MIN_BALANCE_ETH);
} catch {
  throw new Error(`Invalid AGENT_MIN_BALANCE_ETH value: "${AGENT_MIN_BALANCE_ETH}"`);
}
const ARENA_ENTRY_FEE_WEI = parseEther('0.00001');
const ARENA_MIN_BALANCE_WEI = AGENT_MIN_BALANCE_WEI + ARENA_ENTRY_FEE_WEI;
const AGENT_STATE_FILE_PATH = path.resolve(process.cwd(), AGENT_STATE_FILE);

// Contract ABI
const CONTRACT_ABI = parseAbi([
  'function rateBps() view returns (uint256)',
  'function totalPresses() view returns (uint256)',
  'function lastUpdateTime() view returns (uint256)',
  'function timeUntilNextPress(address user) view returns (uint256)',
  'function getCurrentRate() view returns (uint256)',
  'function press()',
  'function RATE_INCREASE_PER_HOUR() view returns (uint256)',
  'function DECREASE_PER_PRESS() view returns (uint256)',
  'function MAX_RATE() view returns (uint256)',
]);
const ARENA_ABI = parseAbi([
  'function enterMatch(string characterId, bool won) payable',
]);


function buildErc8021DataSuffix(codes) {
  const joinedCodes = codes.join(',');
  const codesHex = stringToHex(joinedCodes);
  const codesLength = (codesHex.length - 2) / 2;

  if (codesLength > 255) {
    throw new Error(`Builder codes are too long (${codesLength} bytes). Max is 255 bytes.`);
  }

  return concatHex([
    codesHex,
    numberToHex(codesLength, { size: 1 }),
    numberToHex(0, { size: 1 }), // schema id 0
    ERC8021_DATA_SUFFIX,
  ]);
}

function resolveTxDataSuffix({ dataSuffix, codes, code }) {
  if (dataSuffix) {
    return dataSuffix;
  }

  const resolvedCodes = codes.length > 0 ? codes : (code ? [code] : []);
  if (resolvedCodes.length === 0) {
    return undefined;
  }

  return buildErc8021DataSuffix(resolvedCodes);
}

function resolveAttributionSource({ dataSuffix, codes, code }) {
  if (dataSuffix) {
    return 'DATA_SUFFIX';
  }

  if (codes.length > 0 || code) {
    return 'BUILDER_CODE(S)';
  }

  return null;
}

const TX_DATA_SUFFIX = resolveTxDataSuffix({
  dataSuffix: BUILDER_DATA_SUFFIX,
  codes: BUILDER_CODES,
  code: BUILDER_CODE,
});
const TX_ATTRIBUTION_SOURCE = resolveAttributionSource({
  dataSuffix: BUILDER_DATA_SUFFIX,
  codes: BUILDER_CODES,
  code: BUILDER_CODE,
});
const ARENA_TX_DATA_SUFFIX = resolveTxDataSuffix({
  dataSuffix: ARENA_BUILDER_DATA_SUFFIX,
  codes: ARENA_BUILDER_CODES,
  code: ARENA_BUILDER_CODE,
}) ?? TX_DATA_SUFFIX;
const ARENA_TX_ATTRIBUTION_SOURCE = resolveAttributionSource({
  dataSuffix: ARENA_BUILDER_DATA_SUFFIX,
  codes: ARENA_BUILDER_CODES,
  code: ARENA_BUILDER_CODE,
}) || (ARENA_TX_DATA_SUFFIX ? 'FALLBACK_TO_POWELL' : null);


const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL_READ),
});

function normalizePrivateKey(privateKey) {
  return `0x${privateKey.replace(/^0x/, '')}`;
}

function resolveAgentPrivateKeys() {
  if (AGENT_PRIVATE_KEYS.length > 0) {
    return AGENT_PRIVATE_KEYS;
  }

  if (PRIVATE_KEY) {
    return [PRIVATE_KEY];
  }

  throw new Error('No agent private key found. Set PRIVATE_KEY or AGENT_PRIVATE_KEYS.');
}

function createAgentContexts() {
  const privateKeys = resolveAgentPrivateKeys();

  return privateKeys.map((privateKey, index) => {
    const account = privateKeyToAccount(normalizePrivateKey(privateKey));
    const name = AGENT_NAMES[index] || `Agent-${index + 1}`;
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(BASE_RPC_URL_WRITE),
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    });
    const arenaWalletClient = createWalletClient({
      account,
      chain: base,
      transport: http(BASE_RPC_URL_WRITE),
      ...(ARENA_TX_DATA_SUFFIX ? { dataSuffix: ARENA_TX_DATA_SUFFIX } : {}),
    });

    return {
      index,
      name,
      account,
      walletClient,
      arenaWalletClient,
    };
  });
}

const agents = createAgentContexts();
const agentBehaviorState = loadAgentBehaviorState();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const farcasterPostState = {
  dayKey: '',
  successPostsToday: 0,
};
const arenaDebugState = {
  lastHourStatusKey: '',
  lastLowBalanceHourKey: '',
};

function randomInt(min, max) {
  if (max <= min) {
    return min;
  }
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shortAddress(address) {
  if (!address) {
    return 'unknown';
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function logAgentSkip(message) {
  if (LOG_AGENT_SKIPS) {
    console.log(message);
  }
}

function normalizeAddress(address) {
  return address.toLowerCase();
}

function pickDailyTxTarget() {
  return randomInt(AGENT_DAILY_TX_MIN, AGENT_DAILY_TX_MAX);
}

function pickArenaDailyTxTarget() {
  return randomInt(ARENA_DAILY_TX_MIN, ARENA_DAILY_TX_MAX);
}

function refreshDailyTxBudget(now = new Date()) {
  const dayKey = getUtcDayKey(now);
  const budget = agentBehaviorState.dailyBudget;

  if (!budget || budget.dayKey !== dayKey) {
    agentBehaviorState.dailyBudget = {
      dayKey,
      targetTransactions: pickDailyTxTarget(),
      sentTransactions: 0,
    };
    saveAgentBehaviorState();
  } else {
    const normalizedTarget = Math.max(
      AGENT_DAILY_TX_MIN,
      Math.min(AGENT_DAILY_TX_MAX, Number(budget.targetTransactions || 0))
    );
    const normalizedSent = Math.max(0, Number(budget.sentTransactions || 0));
    if (
      normalizedTarget !== budget.targetTransactions ||
      normalizedSent !== budget.sentTransactions
    ) {
      budget.targetTransactions = normalizedTarget;
      budget.sentTransactions = normalizedSent;
      saveAgentBehaviorState();
    }
  }

  return agentBehaviorState.dailyBudget;
}

function getDailyTxRemaining(now = new Date()) {
  const budget = refreshDailyTxBudget(now);
  return Math.max(0, budget.targetTransactions - budget.sentTransactions);
}

function recordDailyTxSuccess(now = new Date()) {
  const budget = refreshDailyTxBudget(now);
  budget.sentTransactions = Math.min(
    budget.targetTransactions,
    Number(budget.sentTransactions || 0) + 1
  );
  saveAgentBehaviorState();
  return budget;
}

function refreshArenaDailyTxBudget(now = new Date()) {
  const dayKey = getUtcDayKey(now);
  const budget = agentBehaviorState.arenaDailyBudget;

  if (!budget || budget.dayKey !== dayKey) {
    agentBehaviorState.arenaDailyBudget = {
      dayKey,
      targetTransactions: pickArenaDailyTxTarget(),
      sentTransactions: 0,
    };
    saveAgentBehaviorState();
  } else {
    const normalizedTarget = Math.max(
      ARENA_DAILY_TX_MIN,
      Math.min(ARENA_DAILY_TX_MAX, Number(budget.targetTransactions || 0))
    );
    const normalizedSent = Math.max(0, Number(budget.sentTransactions || 0));
    if (
      normalizedTarget !== budget.targetTransactions ||
      normalizedSent !== budget.sentTransactions
    ) {
      budget.targetTransactions = normalizedTarget;
      budget.sentTransactions = normalizedSent;
      saveAgentBehaviorState();
    }
  }

  return agentBehaviorState.arenaDailyBudget;
}

function getArenaDailyTxRemaining(now = new Date()) {
  const budget = refreshArenaDailyTxBudget(now);
  return Math.max(0, budget.targetTransactions - budget.sentTransactions);
}

function recordArenaDailyTxSuccess(now = new Date()) {
  const budget = refreshArenaDailyTxBudget(now);
  budget.sentTransactions = Math.min(
    budget.targetTransactions,
    Number(budget.sentTransactions || 0) + 1
  );
  saveAgentBehaviorState();
  return budget;
}

function pickRandomUniqueArenaHours(count) {
  const targetCount = Math.max(0, Math.min(24, Number(count || 0)));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  for (let i = hours.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [hours[i], hours[j]] = [hours[j], hours[i]];
  }

  return hours
    .slice(0, targetCount)
    .sort((a, b) => a - b)
    .map(hour => ({
      hour,
      executedAt: null,
      executedBy: null,
    }));
}

function buildArenaSchedule(dayKey, targetTransactions) {
  return {
    dayKey,
    slots: pickRandomUniqueArenaHours(targetTransactions),
  };
}

function refreshArenaSchedule(now = new Date()) {
  const budget = refreshArenaDailyTxBudget(now);
  const dayKey = getUtcDayKey(now);
  const targetTransactions = Math.max(
    0,
    Math.min(24, Number(budget?.targetTransactions || 0))
  );
  const schedule = agentBehaviorState.arenaSchedule;

  if (
    !schedule ||
    schedule.dayKey !== dayKey ||
    !Array.isArray(schedule.slots) ||
    schedule.slots.length !== targetTransactions
  ) {
    agentBehaviorState.arenaSchedule = buildArenaSchedule(dayKey, targetTransactions);
    saveAgentBehaviorState();
  } else {
    let changed = false;
    for (const slot of schedule.slots) {
      const normalizedHour = Math.max(0, Math.min(23, Number(slot.hour || 0)));
      if (slot.hour !== normalizedHour) {
        slot.hour = normalizedHour;
        changed = true;
      }
      if (slot.executedAt !== null && typeof slot.executedAt !== 'string') {
        slot.executedAt = null;
        changed = true;
      }
      if (slot.executedBy !== null && typeof slot.executedBy !== 'string') {
        slot.executedBy = null;
        changed = true;
      }
    }

    schedule.slots.sort((a, b) => a.hour - b.hour);
    if (changed) {
      saveAgentBehaviorState();
    }
  }

  return agentBehaviorState.arenaSchedule;
}

function getCurrentArenaSlot(now = new Date()) {
  const schedule = refreshArenaSchedule(now);
  const currentUtcHour = now.getUTCHours();

  return schedule.slots.find(slot => slot.hour === currentUtcHour && !slot.executedAt) || null;
}

function markArenaSlotExecuted(hour, agent, now = new Date()) {
  const schedule = refreshArenaSchedule(now);
  const slot = schedule.slots.find(entry => entry.hour === hour && !entry.executedAt);
  if (!slot) {
    return null;
  }

  slot.executedAt = now.toISOString();
  slot.executedBy = normalizeAddress(agent.account.address);
  saveAgentBehaviorState();
  return slot;
}

function formatArenaScheduleHours(schedule = refreshArenaSchedule()) {
  const hours = Array.isArray(schedule?.slots)
    ? schedule.slots.map(slot => String(slot.hour).padStart(2, '0'))
    : [];
  return hours.length > 0 ? hours.join(', ') : 'none';
}

function formatUtcHourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

function formatArenaHourList(hours) {
  return hours.length > 0
    ? hours.map(hour => formatUtcHourLabel(hour)).join(', ')
    : 'none';
}

function getRemainingArenaHours(schedule, now = new Date()) {
  const currentUtcHour = now.getUTCHours();
  return schedule.slots
    .filter(slot => !slot.executedAt && slot.hour >= currentUtcHour)
    .map(slot => slot.hour);
}

function logArenaHourStatus(now = new Date()) {
  if (!ARENA_ENABLED || !ARENA_DEBUG_LOGS) {
    return;
  }

  const hourStatusKey = `${getUtcDayKey(now)}:${now.getUTCHours()}`;
  if (arenaDebugState.lastHourStatusKey === hourStatusKey) {
    return;
  }
  arenaDebugState.lastHourStatusKey = hourStatusKey;

  const schedule = refreshArenaSchedule(now);
  const currentUtcHour = now.getUTCHours();
  const currentSlot = schedule.slots.find(slot => slot.hour === currentUtcHour) || null;
  const remainingHours = getRemainingArenaHours(schedule, now);

  if (currentSlot?.executedAt) {
    console.log(
      `[arena] Slot ${formatUtcHourLabel(currentUtcHour)} already executed by ${shortAddress(currentSlot.executedBy)}. Remaining today: ${formatArenaHourList(remainingHours)}`
    );
    return;
  }

  if (currentSlot) {
    console.log(
      `[arena] Active slot ${formatUtcHourLabel(currentUtcHour)}. Remaining today: ${formatArenaHourList(remainingHours)}`
    );
    return;
  }

  console.log(
    `[arena] No active slot at ${formatUtcHourLabel(currentUtcHour)}. Remaining today: ${formatArenaHourList(remainingHours)}`
  );
}

function logArenaLowBalance(agent, balanceWei, now = new Date()) {
  if (!ARENA_DEBUG_LOGS) {
    return;
  }

  const hourStatusKey = `${getUtcDayKey(now)}:${now.getUTCHours()}`;
  if (arenaDebugState.lastLowBalanceHourKey === hourStatusKey) {
    return;
  }
  arenaDebugState.lastLowBalanceHourKey = hourStatusKey;

  console.log(
    `[arena] First low-balance miss in ${formatUtcHourLabel(now.getUTCHours())}: ${agent.name} ${shortAddress(agent.account.address)} has ${formatEther(balanceWei)} ETH, needs at least ${formatEther(ARENA_MIN_BALANCE_WEI)} ETH.`
  );
}

function getAgentPriorityBucket(agent, now = Date.now()) {
  const state = ensureAgentTracked(agent, now);
  const ageDays = getAgentAgeDays(state.firstSeenAt, now);
  const isPriority = ageDays <= AGENT_NEW_PRIORITY_DAYS;
  return {
    agent,
    ageDays,
    isPriority,
    tieBreak: Math.random(),
  };
}

function buildRunQueueByPriority(now = Date.now()) {
  const entries = agents.map(agent => getAgentPriorityBucket(agent, now));

  entries.sort((a, b) => {
    if (a.isPriority !== b.isPriority) {
      return a.isPriority ? -1 : 1;
    }
    if (a.ageDays !== b.ageDays) {
      return a.ageDays - b.ageDays;
    }
    return a.tieBreak - b.tieBreak;
  });

  return entries.map(entry => entry.agent);
}

function loadAgentBehaviorState() {
  try {
    if (!fs.existsSync(AGENT_STATE_FILE_PATH)) {
      return { agents: {}, dailyBudget: null, arenaDailyBudget: null, arenaSchedule: null };
    }

    const raw = fs.readFileSync(AGENT_STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.agents !== 'object') {
      return { agents: {}, dailyBudget: null, arenaDailyBudget: null, arenaSchedule: null };
    }
    if (!parsed.dailyBudget || typeof parsed.dailyBudget !== 'object') {
      parsed.dailyBudget = null;
    }
    if (!parsed.arenaDailyBudget || typeof parsed.arenaDailyBudget !== 'object') {
      parsed.arenaDailyBudget = null;
    }
    if (!parsed.arenaSchedule || typeof parsed.arenaSchedule !== 'object') {
      parsed.arenaSchedule = null;
    }
    return parsed;
  } catch (error) {
    console.warn(`Failed to read ${AGENT_STATE_FILE_PATH}, starting with empty state:`, error.message);
    return { agents: {}, dailyBudget: null, arenaDailyBudget: null, arenaSchedule: null };
  }
}

function saveAgentBehaviorState() {
  try {
    fs.mkdirSync(path.dirname(AGENT_STATE_FILE_PATH), { recursive: true });
    fs.writeFileSync(AGENT_STATE_FILE_PATH, JSON.stringify(agentBehaviorState, null, 2));
  } catch (error) {
    console.warn(`Failed to save ${AGENT_STATE_FILE_PATH}:`, error.message);
  }
}

function ensureAgentTracked(agent, now = Date.now()) {
  const key = normalizeAddress(agent.account.address);
  if (!agentBehaviorState.agents[key]) {
    agentBehaviorState.agents[key] = {
      name: agent.name,
      firstSeenAt: new Date(now).toISOString(),
      successfulPresses: 0,
      lastSuccessAt: null,
    };
    saveAgentBehaviorState();
  } else if (agentBehaviorState.agents[key].name !== agent.name) {
    agentBehaviorState.agents[key].name = agent.name;
    saveAgentBehaviorState();
  }

  return agentBehaviorState.agents[key];
}

function ensureAllAgentsTracked(now = Date.now()) {
  let changed = false;
  for (const agent of agents) {
    const key = normalizeAddress(agent.account.address);
    if (!agentBehaviorState.agents[key]) {
      agentBehaviorState.agents[key] = {
        name: agent.name,
        firstSeenAt: new Date(now).toISOString(),
        successfulPresses: 0,
        lastSuccessAt: null,
      };
      changed = true;
    } else if (agentBehaviorState.agents[key].name !== agent.name) {
      agentBehaviorState.agents[key].name = agent.name;
      changed = true;
    }
  }

  if (changed) {
    saveAgentBehaviorState();
  }
}

function getAgentAgeDays(firstSeenAt, now = Date.now()) {
  const firstSeenMs = Date.parse(firstSeenAt || '');
  if (!Number.isFinite(firstSeenMs)) {
    return 0;
  }
  return Math.max(0, Math.floor((now - firstSeenMs) / DAY_MS));
}

function getAgentActionChance(agent, now = Date.now()) {
  const state = ensureAgentTracked(agent, now);
  const ageDays = getAgentAgeDays(state.firstSeenAt, now);
  const decayedChance = AGENT_NEW_ACTION_CHANCE * (AGENT_ACTION_CHANCE_DAILY_DECAY ** ageDays);
  const actionChance = Math.max(AGENT_MIN_ACTION_CHANCE, Math.min(1, decayedChance));

  return {
    ageDays,
    actionChance,
  };
}

function markAgentPressSuccess(agent, now = Date.now()) {
  const state = ensureAgentTracked(agent, now);
  state.successfulPresses = Number(state.successfulPresses || 0) + 1;
  state.lastSuccessAt = new Date(now).toISOString();
  saveAgentBehaviorState();
}

function getUtcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function refreshFarcasterPostWindow(now = new Date()) {
  const dayKey = getUtcDayKey(now);
  if (farcasterPostState.dayKey !== dayKey) {
    farcasterPostState.dayKey = dayKey;
    farcasterPostState.successPostsToday = 0;
  }
}

function canPostSuccessToFarcaster(now = new Date()) {
  refreshFarcasterPostWindow(now);
  return farcasterPostState.successPostsToday < FARCASTER_MAX_SUCCESS_POSTS_PER_DAY;
}

function markSuccessPostToFarcaster(now = new Date()) {
  refreshFarcasterPostWindow(now);
  farcasterPostState.successPostsToday += 1;
}

function isRateLimitError(error) {
  const status = error?.status || error?.cause?.status || error?.cause?.cause?.status;
  const code = error?.code || error?.cause?.code || error?.cause?.cause?.code;
  const message = String(error?.message || '').toLowerCase();
  const details = String(error?.details || '').toLowerCase();
  const shortMessage = String(error?.shortMessage || '').toLowerCase();

  return (
    status === 429 ||
    code === -32016 ||
    message.includes('rate limit') ||
    details.includes('rate limit') ||
    shortMessage.includes('rate limit') ||
    message.includes('over rate limit') ||
    details.includes('over rate limit') ||
    shortMessage.includes('over rate limit')
  );
}

function isInsufficientFundsError(error) {
  const message = [
    error?.message,
    error?.shortMessage,
    error?.details,
    error?.cause?.message,
    error?.cause?.shortMessage,
    error?.cause?.details,
    error?.cause?.cause?.message,
    error?.cause?.cause?.shortMessage,
    error?.cause?.cause?.details,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    message.includes('insufficient funds') ||
    message.includes('exceeds balance') ||
    message.includes('exceeds the balance')
  );
}

async function withRpcRetry(fn, label) {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const isRateLimit = isRateLimitError(error);

      if (!isRateLimit || attempt > RPC_MAX_RETRIES) {
        throw error;
      }

      const backoff = Math.min(RPC_MAX_DELAY_MS, RPC_BASE_DELAY_MS * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * RPC_JITTER_MS);
      const waitMs = backoff + jitter;

      console.log(`RPC rate limited${label ? ` (${label})` : ''}. Retry ${attempt}/${RPC_MAX_RETRIES} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

async function getAgentBalanceWei(address, label = 'agentBalance') {
  return await withRpcRetry(
    () => publicClient.getBalance({ address }),
    label
  );
}



async function getPrePressSnapshot(address, label = 'prePressSnapshot') {
  const [rate, presses, cooldown] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'totalPresses',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'timeUntilNextPress',
          args: [address],
        },
      ],
    }),
    label
  );

  return {
    rate: Number(rate) / 100,
    presses: Number(presses),
    cooldown: Number(cooldown),
  };
}

async function getPostPressSnapshot(label = 'postPressSnapshot') {
  const [rate, presses] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'totalPresses',
        },
      ],
    }),
    label
  );

  return {
    rate: Number(rate) / 100,
    presses: Number(presses),
  };
}

async function pressPowell(agent) {
  console.log(`[${agent.name}] Attempting to press Powell...`);
  
  const { request } = await withRpcRetry(
    () => publicClient.simulateContract({
      account: agent.account,
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'press',
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    }),
    `simulatePress:${agent.name}`
  );

  const hash = await withRpcRetry(
    () => agent.walletClient.writeContract(request),
    `writePress:${agent.name}`
  );
  console.log(`[${agent.name}] Transaction sent:`, hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    `waitForReceipt:${agent.name}`
  );
  console.log(`[${agent.name}] Transaction confirmed!`);
  
  return receipt;
}

async function playArena(agent) {
  const characterId = pickRandom(ARENA_CHARACTERS);
  const won = Math.random() > 0.4;
  const resultLabel = won ? 'won' : 'lost';

  if (!characterId) {
    console.log(`[${agent.name}] No arena characters configured, skipping 33balances.`);
    return null;
  }

  console.log(`[${agent.name}] Playing 33balances as ${characterId} - result: ${resultLabel}`);

  try {
    const { request } = await withRpcRetry(
      () => publicClient.simulateContract({
        account: agent.account,
        address: ARENA_CONTRACT_ADDRESS,
        abi: ARENA_ABI,
        functionName: 'enterMatch',
        args: [characterId, won],
        value: parseEther('0.00001'),
        ...(ARENA_TX_DATA_SUFFIX ? { dataSuffix: ARENA_TX_DATA_SUFFIX } : {}),
      }),
      `simulateArena:${agent.name}`
    );

    const hash = await withRpcRetry(
      () => agent.arenaWalletClient.writeContract(request),
      `writeArena:${agent.name}`
    );
    console.log(`[${agent.name}] Arena transaction sent:`, hash);

    const receipt = await withRpcRetry(
      () => publicClient.waitForTransactionReceipt({ hash }),
      `waitForArenaReceipt:${agent.name}`
    );
    console.log(`[${agent.name}] 33balances transaction confirmed!`);

    return receipt;
  } catch (error) {
    console.error(`[${agent.name}] 33balances error:`, error);

    if (isInsufficientFundsError(error)) {
      console.log(`[${agent.name}] Insufficient ETH for 33balances entry. Top up this wallet to resume arena actions.`);
    } else {
      console.log(`[${agent.name}] Skipping 33balances for this run.`);
    }

    throw error;
  }
}

async function maybePlayArena(agent) {
  try {
    if (!ARENA_ENABLED) {
      return false;
    }

    const now = new Date();
    logArenaHourStatus(now);

    if (agent.index >= ARENA_AGENTS_COUNT) {
      return false;
    }

    const arenaSlot = getCurrentArenaSlot(now);
    if (!arenaSlot) {
      return false;
    }

    const arenaRemaining = getArenaDailyTxRemaining(now);
    if (arenaRemaining <= 0) {
      return false;
    }

    const balanceWei = await getAgentBalanceWei(agent.account.address, `arenaBalance:${agent.name}`);
    if (balanceWei < ARENA_MIN_BALANCE_WEI) {
      logArenaLowBalance(agent, balanceWei, now);
      return false;
    }

    const arenaDelayMs = randomInt(ARENA_ACTION_DELAY_MIN_MS, ARENA_ACTION_DELAY_MAX_MS);
    console.log(
      `[${agent.name}] Arena slot active for ${String(arenaSlot.hour).padStart(2, '0')}:00 UTC. Action delay: ${arenaDelayMs}ms`
    );
    await sleep(arenaDelayMs);

    const arenaReceipt = await playArena(agent);
    if (!arenaReceipt) {
      return false;
    }

    const arenaBudget = recordArenaDailyTxSuccess();
    markArenaSlotExecuted(arenaSlot.hour, agent);
    console.log(
      `[${agent.name}] Arena daily usage: ${arenaBudget.sentTransactions}/${arenaBudget.targetTransactions} (${arenaBudget.dayKey})`
    );
    return true;
  } catch (error) {
    console.error(`[${agent.name}] Arena scheduling error:`, error);
    return false;
  }
}



async function postToFarcaster(text) {
  if (!FARCASTER_POSTS_ENABLED) {
    console.log('Farcaster posting disabled by config');
    return;
  }

  if (!NEYNAR_API_KEY || !FARCASTER_SIGNER_UUID) {
    console.log('Farcaster not configured, skipping post');
    console.log('Would have posted:', text);
    return;
  }

  try {
    const response = await axios.post(
      'https://api.neynar.com/v2/farcaster/cast',
      {
        signer_uuid: FARCASTER_SIGNER_UUID,
        text,
      },
      {
        headers: {
          'api_key': NEYNAR_API_KEY,
          'content-type': 'application/json',
        },
      }
    );

    console.log('Posted to Farcaster:', response.data.cast.hash);
    return response.data;
  } catch (error) {
    console.error('Failed to post to Farcaster:', error.response?.data || error.message);
  }
}


async function runAgent(agent, cycleContext = null) {
  try {
    await maybePlayArena(agent);

    if (cycleContext && cycleContext.sentTransactions >= cycleContext.maxTransactions) {
      logAgentSkip(
        `[${agent.name}] Cycle tx budget reached (${cycleContext.sentTransactions}/${cycleContext.maxTransactions}), skipping Powell.`
      );
      return;
    }

    const balanceWei = await getAgentBalanceWei(agent.account.address, `balance:${agent.name}`);
    if (balanceWei < AGENT_MIN_BALANCE_WEI) {
      logAgentSkip(
        `[${agent.name}] Low ETH balance: ${formatEther(balanceWei)} ETH (min ${AGENT_MIN_BALANCE_ETH} ETH). Skipping run.`
      );
      return;
    }

    const preSnapshot = await getPrePressSnapshot(agent.account.address, `prePressSnapshot:${agent.name}`);
    const cooldown = preSnapshot.cooldown;
    if (cooldown > 0) {
      const minutes = Math.floor(cooldown / 60);
      const seconds = cooldown % 60;
      logAgentSkip(`[${agent.name}] Cooldown active: ${minutes}m ${seconds}s remaining`);
      return;
    }

    const skipRoll = Math.random();
    if (skipRoll < AGENT_RANDOM_SKIP_CHANCE) {
      const rollPct = (skipRoll * 100).toFixed(1);
      const thresholdPct = (AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1);
      logAgentSkip(
        `[${agent.name}] Random skip this cycle (roll ${rollPct}% < threshold ${thresholdPct}%)`
      );
      return;
    }

    const { ageDays, actionChance } = getAgentActionChance(agent);
    const ageRoll = Math.random();
    if (ageRoll > actionChance) {
      const rollPct = (ageRoll * 100).toFixed(1);
      const chancePct = (actionChance * 100).toFixed(1);
      logAgentSkip(
        `[${agent.name}] Age-weighted skip (age ${ageDays}d, roll ${rollPct}% > chance ${chancePct}%).`
      );
      return;
    }

    const actionDelayMs = randomInt(AGENT_ACTION_DELAY_MIN_MS, AGENT_ACTION_DELAY_MAX_MS);
    if (actionDelayMs > 0) {
      await sleep(actionDelayMs);
    }

    const readySnapshot = await getPrePressSnapshot(
      agent.account.address,
      `prePressAfterDelay:${agent.name}`
    );
    const readyCooldown = readySnapshot.cooldown;
    if (readyCooldown > 0) {
      const minutes = Math.floor(readyCooldown / 60);
      const seconds = readyCooldown % 60;
      logAgentSkip(`[${agent.name}] Cooldown became active after delay: ${minutes}m ${seconds}s`);
      return;
    }

    const rateBefore = readySnapshot.rate;
    const pressesBefore = readySnapshot.presses;

    console.log(`[${agent.name}] Current Rate: ${rateBefore.toFixed(2)}%`);
    console.log(`[${agent.name}] Total Presses: ${pressesBefore}`);

    await pressPowell(agent);
    markAgentPressSuccess(agent);
    if (cycleContext) {
      const dailyBudget = recordDailyTxSuccess();
      cycleContext.sentTransactions += 1;
      console.log(
        `[${agent.name}] Cycle tx usage: ${cycleContext.sentTransactions}/${cycleContext.maxTransactions}`
      );
      console.log(
        `[${agent.name}] Daily tx usage: ${dailyBudget.sentTransactions}/${dailyBudget.targetTransactions} (${dailyBudget.dayKey})`
      );
    } else {
      recordDailyTxSuccess();
    }

    await sleep(5000);

    const postSnapshot = await getPostPressSnapshot(`postPressSnapshot:${agent.name}`);
    const rateAfter = postSnapshot.rate;
    const pressesAfter = postSnapshot.presses;

    console.log(`\n[${agent.name}] New Rate: ${rateAfter.toFixed(2)}%`);
    console.log(`[${agent.name}] Total Presses: ${pressesAfter}`);

    const castPersona = pickRandom(CAST_PERSONAS);
    const messages = [
      `Agent ${castPersona} landed a hit.\n\nFed Rate: ${rateBefore.toFixed(2)}% -> ${rateAfter.toFixed(2)}%\nTotal hits: ${pressesAfter}\n\n${APP_URL}`,
      `${castPersona} reports mission success.\n\nRate now: ${rateAfter.toFixed(2)}%\nPress count: ${pressesAfter}\n\n${APP_URL}`,
      `${castPersona} executed press().\n\nFed Rate: ${rateBefore.toFixed(2)}% -> ${rateAfter.toFixed(2)}%\nHit #${pressesAfter}\n\n${APP_URL}`,
    ];

    if (FARCASTER_POSTS_ENABLED && canPostSuccessToFarcaster()) {
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      const postResult = await postToFarcaster(randomMessage);
      if (postResult) {
        markSuccessPostToFarcaster();
      }
    }

    console.log(`\n[${agent.name}] Agent run completed successfully!\n`);
  } catch (error) {
    console.error(`[${agent.name}] Agent error:`, error);

    if (isInsufficientFundsError(error)) {
      console.log(`[${agent.name}] Insufficient ETH for gas. Top up this wallet to resume actions.`);
    } else if (String(error?.message || '').includes('cooldown')) {
      logAgentSkip('Cooldown error - this is normal, will try next hour');
    } else {
      console.log(`[${agent.name}] Agent run failed.`);
    }
  }
}

async function checkStatus(agent) {
  try {
    console.log(`\n${agent.name} Status Check\n`);

    const snapshot = await getPrePressSnapshot(agent.account.address, `statusSnapshot:${agent.name}`);
    const rate = snapshot.rate;
    const presses = snapshot.presses;
    const cooldown = snapshot.cooldown;

    console.log(`Current Rate: ${rate.toFixed(2)}%`);
    console.log(`Total Presses: ${presses}`);
    console.log(`Agent Address: ${agent.account.address}`);
    console.log(`Cooldown: ${cooldown}s`);

    if (cooldown === 0) {
      console.log('\nReady to press!');
    } else {
      const minutes = Math.floor(cooldown / 60);
      console.log(`\nNext press available in ${minutes} minutes`);
    }
  } catch (error) {
    console.error(`[${agent.name}] Status check error:`, error);
  }
}

async function runAllAgents(mode) {
  const runQueue = mode === 'run' ? buildRunQueueByPriority() : agents;
  const cycleContext = mode === 'run'
    ? {
      sentTransactions: 0,
      maxTransactions: Math.min(AGENT_CYCLE_MAX_TRANSACTIONS, getDailyTxRemaining()),
    }
    : null;

  if (mode === 'run') {
    const dailyBudget = refreshDailyTxBudget();
    const dailyRemaining = Math.max(0, dailyBudget.targetTransactions - dailyBudget.sentTransactions);
    console.log(
      `Daily tx budget: ${dailyBudget.sentTransactions}/${dailyBudget.targetTransactions} used (${dailyBudget.dayKey}), remaining ${dailyRemaining}`
    );
    console.log(`Run cycle tx budget: ${cycleContext.maxTransactions} tx max`);
    if (cycleContext.maxTransactions <= 0) {
      console.log('Daily tx cap reached. Skipping this cycle.');
      return;
    }
  }

  for (let i = 0; i < runQueue.length; i++) {
    const agent = runQueue[i];

    try {
      if (mode === 'status') {
        await checkStatus(agent);
      } else {
        await runAgent(agent, cycleContext);
      }
    } catch (error) {
      console.error(`[${agent.name}] Unhandled loop error:`, error);
    }

    const shouldWait = i < runQueue.length - 1 && AGENT_RUN_STAGGER_MS > 0;
    if (shouldWait) {
      if (LOG_AGENT_STAGGER_WAIT) {
        console.log(`Waiting ${AGENT_RUN_STAGGER_MS}ms before next agent...`);
      }
      await sleep(AGENT_RUN_STAGGER_MS);
    }
  }
}

async function startAgent() {
  ensureAllAgentsTracked();
  console.log('\nRate Slayer Agent Started!\n');
  console.log('Will run every hour on the hour');
  console.log('Agents configured:', agents.length);
  if (LOG_AGENT_ADDRESSES) {
    for (const agent of agents) {
      console.log(`Agent ${agent.name}: ${agent.account.address}`);
    }
  }
  const uniqueAgentCount = new Set(agents.map(agent => agent.account.address.toLowerCase())).size;
  if (uniqueAgentCount !== agents.length) {
    console.log('WARNING: Duplicate agent addresses detected. Use unique private keys for true multi-agent behavior.');
  }
  console.log('Contract:', CONTRACT_ADDRESS);
  console.log('Arena gameplay:', ARENA_ENABLED ? 'enabled' : 'disabled');
  console.log(
    'Arena eligible agents:',
    ARENA_AGENTS_COUNT === Number.MAX_SAFE_INTEGER ? 'all' : `${ARENA_AGENTS_COUNT}`
  );
  console.log('Arena contract:', ARENA_CONTRACT_ADDRESS);
  console.log('Arena daily target range:', `${ARENA_DAILY_TX_MIN}-${ARENA_DAILY_TX_MAX} tx`);
  console.log('Arena action delay range:', `${ARENA_ACTION_DELAY_MIN_MS}-${ARENA_ACTION_DELAY_MAX_MS}ms`);
  console.log('Arena schedule timezone:', 'UTC hour windows');
  console.log('Arena debug logs:', ARENA_DEBUG_LOGS ? 'enabled' : 'disabled');
  console.log('Farcaster posting:', FARCASTER_POSTS_ENABLED ? 'enabled' : 'disabled');
  console.log('Farcaster posting mode:', 'success-only');
  console.log('Farcaster success post limit:', `${FARCASTER_MAX_SUCCESS_POSTS_PER_DAY} per UTC day`);
  console.log('Powell attribution:', TX_DATA_SUFFIX ? 'enabled' : 'disabled');
  console.log('Arena attribution:', ARENA_TX_DATA_SUFFIX ? 'enabled' : 'disabled');
  console.log('Agent stagger:', `${AGENT_RUN_STAGGER_MS}ms`);
  console.log('Random skip chance:', `${(AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1)}%`);
  console.log('New agent action chance:', `${(AGENT_NEW_ACTION_CHANCE * 100).toFixed(1)}%`);
  console.log('Daily action chance decay:', `${(AGENT_ACTION_CHANCE_DAILY_DECAY * 100).toFixed(2)}%`);
  console.log('Min action chance floor:', `${(AGENT_MIN_ACTION_CHANCE * 100).toFixed(1)}%`);
  console.log('Random action delay range:', `${AGENT_ACTION_DELAY_MIN_MS}-${AGENT_ACTION_DELAY_MAX_MS}ms`);
  console.log('Cycle transaction budget:', `${AGENT_CYCLE_MAX_TRANSACTIONS} tx`);
  console.log('Daily transaction target range:', `${AGENT_DAILY_TX_MIN}-${AGENT_DAILY_TX_MAX} tx`);
  console.log('New agent priority window:', `${AGENT_NEW_PRIORITY_DAYS} day(s)`);
  console.log('Min agent gas balance:', `${AGENT_MIN_BALANCE_ETH} ETH`);
  console.log('Run immediately on startup:', RUN_ON_START ? 'enabled' : 'disabled');
  console.log('Agent behavior state file:', AGENT_STATE_FILE_PATH);
  console.log('Skip logs:', LOG_AGENT_SKIPS ? 'enabled' : 'disabled');
  console.log('Agent address logs:', LOG_AGENT_ADDRESSES ? 'enabled' : 'disabled');
  const dailyBudget = refreshDailyTxBudget();
  console.log(
    'Daily tx budget state:',
    `${dailyBudget.sentTransactions}/${dailyBudget.targetTransactions} (${dailyBudget.dayKey})`
  );
  if (ARENA_ENABLED) {
    const arenaDailyBudget = refreshArenaDailyTxBudget();
    console.log(
      'Arena daily budget state:',
      `${arenaDailyBudget.sentTransactions}/${arenaDailyBudget.targetTransactions} (${arenaDailyBudget.dayKey})`
    );
    console.log('Arena schedule hours (UTC):', formatArenaScheduleHours());
  }
  if (TX_DATA_SUFFIX) {
    console.log('Powell attribution source:', TX_ATTRIBUTION_SOURCE);
  }
  if (ARENA_TX_DATA_SUFFIX) {
    console.log('Arena attribution source:', ARENA_TX_ATTRIBUTION_SOURCE);
  }
  console.log('\n' + '='.repeat(50) + '\n');

  if (process.argv.includes('--once')) {
    console.log('Running in test mode (one-time execution)');
    await runAllAgents('run');
    process.exit(0);
  }

  if (process.argv.includes('--status')) {
    await runAllAgents('status');
    process.exit(0);
  }

  if (RUN_ON_START) {
    await runAllAgents('run');
  } else {
    console.log('Startup run skipped. Waiting for next scheduled cycle.');
  }

  cron.schedule('0 * * * *', async () => {
    await runAllAgents('run');
  });

  console.log('Scheduler active. Agents will run every hour.');
  console.log('Press Ctrl+C to stop\n');
}

startAgent().catch(console.error);
