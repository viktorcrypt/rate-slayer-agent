import { concatHex, createPublicClient, createWalletClient, http, numberToHex, parseAbi, stringToHex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import cron from 'node-cron';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();


const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0xeC6AF3c5934F383972bb9980A51EC976099270b8';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AGENT_PRIVATE_KEYS = (process.env.AGENT_PRIVATE_KEYS || '')
  .split(',')
  .map(key => key.trim())
  .filter(Boolean);
const AGENT_NAMES = (process.env.AGENT_NAMES || '')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
const AGENT_RUN_STAGGER_MS = Math.max(0, Number(process.env.AGENT_RUN_STAGGER_MS || 3000));
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
const BUILDER_CODE = process.env.BUILDER_CODE?.trim();
const BUILDER_CODES = (process.env.BUILDER_CODES || '')
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
const BUILDER_DATA_SUFFIX = process.env.BUILDER_DATA_SUFFIX?.trim();
const ERC8021_DATA_SUFFIX = '0x80218021802180218021802180218021';
const FARCASTER_MAX_SUCCESS_POSTS_PER_DAY = 1;
const CAST_PERSONAS = ['Atlas', 'Rook', 'Mantis', 'Viper', 'Nova', 'Sentinel', 'Cipher', 'Falcon'];

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

function resolveTxDataSuffix() {
  if (BUILDER_DATA_SUFFIX) {
    return BUILDER_DATA_SUFFIX;
  }

  const codes = BUILDER_CODES.length > 0 ? BUILDER_CODES : (BUILDER_CODE ? [BUILDER_CODE] : []);
  if (codes.length === 0) {
    return undefined;
  }

  return buildErc8021DataSuffix(codes);
}

const TX_DATA_SUFFIX = resolveTxDataSuffix();


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

    return {
      index,
      name,
      account,
      walletClient,
    };
  });
}

const agents = createAgentContexts();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const farcasterPostState = {
  dayKey: '',
  successPostsToday: 0,
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


async function runAgent(agent) {
  try {
    console.log('\n' + '='.repeat(50));
    console.log(`${agent.name} running...`);
    console.log('Time:', new Date().toLocaleString());
    console.log('Agent Address:', agent.account.address);
    console.log('='.repeat(50) + '\n');

    const preSnapshot = await getPrePressSnapshot(agent.account.address, `prePressSnapshot:${agent.name}`);
    const cooldown = preSnapshot.cooldown;
    if (cooldown > 0) {
      const minutes = Math.floor(cooldown / 60);
      const seconds = cooldown % 60;
      console.log(`[${agent.name}] Cooldown active: ${minutes}m ${seconds}s remaining`);
      console.log('Skipping this run...\n');
      return;
    }

    const skipRoll = Math.random();
    if (skipRoll < AGENT_RANDOM_SKIP_CHANCE) {
      const rollPct = (skipRoll * 100).toFixed(1);
      const thresholdPct = (AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1);
      console.log(
        `[${agent.name}] Random skip this cycle (roll ${rollPct}% < threshold ${thresholdPct}%)`
      );
      return;
    }

    const actionDelayMs = randomInt(AGENT_ACTION_DELAY_MIN_MS, AGENT_ACTION_DELAY_MAX_MS);
    if (actionDelayMs > 0) {
      console.log(`[${agent.name}] Random action delay: ${actionDelayMs}ms`);
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
      console.log(`[${agent.name}] Cooldown became active after delay: ${minutes}m ${seconds}s`);
      return;
    }

    const rateBefore = readySnapshot.rate;
    const pressesBefore = readySnapshot.presses;

    console.log(`[${agent.name}] Current Rate: ${rateBefore.toFixed(2)}%`);
    console.log(`[${agent.name}] Total Presses: ${pressesBefore}`);

    await pressPowell(agent);

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

    if (!FARCASTER_POSTS_ENABLED) {
      console.log('Skipping Farcaster post (disabled)');
    } else if (!canPostSuccessToFarcaster()) {
      console.log('Skipping Farcaster post (daily success post limit reached)');
    } else {
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      const postResult = await postToFarcaster(randomMessage);
      if (postResult) {
        markSuccessPostToFarcaster();
      }
    }

    console.log(`\n[${agent.name}] Agent run completed successfully!\n`);
  } catch (error) {
    console.error(`[${agent.name}] Agent error:`, error);

    if (String(error?.message || '').includes('cooldown')) {
      console.log('Cooldown error - this is normal, will try next hour');
    } else {
      console.log('Skipping Farcaster error post (success-only mode)');
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
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    if (mode === 'status') {
      await checkStatus(agent);
    } else {
      await runAgent(agent);
    }

    const shouldWait = i < agents.length - 1 && AGENT_RUN_STAGGER_MS > 0;
    if (shouldWait) {
      console.log(`Waiting ${AGENT_RUN_STAGGER_MS}ms before next agent...`);
      await sleep(AGENT_RUN_STAGGER_MS);
    }
  }
}

async function startAgent() {
  console.log('\nRate Slayer Agent Started!\n');
  console.log('Will run every hour on the hour');
  console.log('Agents configured:', agents.length);
  for (const agent of agents) {
    console.log(`Agent ${agent.name}: ${agent.account.address}`);
  }
  const uniqueAgentCount = new Set(agents.map(agent => agent.account.address.toLowerCase())).size;
  if (uniqueAgentCount !== agents.length) {
    console.log('WARNING: Duplicate agent addresses detected. Use unique private keys for true multi-agent behavior.');
  }
  console.log('Contract:', CONTRACT_ADDRESS);
  console.log('Farcaster posting:', FARCASTER_POSTS_ENABLED ? 'enabled' : 'disabled');
  console.log('Farcaster posting mode:', 'success-only');
  console.log('Farcaster success post limit:', `${FARCASTER_MAX_SUCCESS_POSTS_PER_DAY} per UTC day`);
  console.log('Builder attribution:', TX_DATA_SUFFIX ? 'enabled' : 'disabled');
  console.log('Agent stagger:', `${AGENT_RUN_STAGGER_MS}ms`);
  console.log('Random skip chance:', `${(AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1)}%`);
  console.log('Random action delay range:', `${AGENT_ACTION_DELAY_MIN_MS}-${AGENT_ACTION_DELAY_MAX_MS}ms`);
  if (TX_DATA_SUFFIX) {
    const attributionSource = BUILDER_DATA_SUFFIX ? 'BUILDER_DATA_SUFFIX' : 'BUILDER_CODE(S)';
    console.log('Attribution source:', attributionSource);
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

  await runAllAgents('run');

  cron.schedule('0 * * * *', async () => {
    await runAllAgents('run');
  });

  console.log('Scheduler active. Agents will run every hour.');
  console.log('Press Ctrl+C to stop\n');
}

startAgent().catch(console.error);
