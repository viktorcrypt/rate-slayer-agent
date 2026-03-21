import axios from 'axios';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEther } from 'viem';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.resolve(repoRoot, '.env') });
dotenv.config({ path: path.resolve(__dirname, '.env'), override: true });

const { startApiServer } = await import('./src/api.js');
const {
  getActiveGames,
  getDailyActionStats,
  getDailyBudgetStatus,
  initDb,
  saveDecision,
  saveTransaction,
} = await import('./src/db.js');
const {
  checkSpendingAllowed,
  getSpendingSnapshot,
} = await import('./src/guard.js');
const { askLLM } = await import('./src/brain.js');
const {
  TX_DATA_SUFFIX,
  createAgentContexts,
  estimatePressEthCost,
  estimatePressWithBetEthCost,
  getAgentBalanceWei,
  getAgentStatsOnchain,
  getPostPressSnapshot,
  getPrePressSnapshot,
  pressPowell,
  pressWithBet,
  registerAgentOnchain,
  updateAgentLimitOnchain,
} = await import('./src/executor.js');

const AGENT_RUN_STAGGER_MS = Math.max(0, Number(process.env.AGENT_RUN_STAGGER_MS || 3000));
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const FARCASTER_SIGNER_UUID = process.env.FARCASTER_SIGNER_UUID;
const FARCASTER_POSTS_ENABLED = String(process.env.FARCASTER_POSTS_ENABLED || 'false').toLowerCase() === 'true';
const APP_URL = process.env.APP_URL || 'https://rate-slayer.vercel.app';
const AGENT_RANDOM_SKIP_CHANCE = Math.min(
  0.95,
  Math.max(0, Number(process.env.AGENT_RANDOM_SKIP_CHANCE || 0.35))
);
const AGENT_ACTION_DELAY_MIN_MS = Math.max(0, Number(process.env.AGENT_ACTION_DELAY_MIN_MS || 15000));
const AGENT_ACTION_DELAY_MAX_MS = Math.max(
  AGENT_ACTION_DELAY_MIN_MS,
  Number(process.env.AGENT_ACTION_DELAY_MAX_MS || 180000)
);
const AGENT_POLL_CRON = process.env.AGENT_POLL_CRON || '*/5 * * * *';
const AGENT_MIN_BALANCE_ETH = process.env.AGENT_MIN_BALANCE_ETH || '0.000001';
const AGENT_CYCLE_MAX_TRANSACTIONS = Math.max(1, Number(process.env.AGENT_CYCLE_MAX_TRANSACTIONS || 2));
const AGENT_DAILY_TX_MIN = Math.max(1, Number(process.env.AGENT_DAILY_TX_MIN || 15));
const AGENT_DAILY_TX_MAX = Math.max(AGENT_DAILY_TX_MIN, Number(process.env.AGENT_DAILY_TX_MAX || 20));
const RUN_ON_START = String(process.env.RUN_ON_START || 'false').toLowerCase() === 'true';
const FARCASTER_MAX_SUCCESS_POSTS_PER_DAY = 1;
const CAST_PERSONAS = ['Atlas', 'Rook', 'Mantis', 'Viper', 'Nova', 'Sentinel', 'Cipher', 'Falcon'];
const DEMO_AGENT_ADDRESS = process.env.DEMO_AGENT_ADDRESS?.trim().toLowerCase() || '';

let AGENT_MIN_BALANCE_WEI;
try {
  AGENT_MIN_BALANCE_WEI = parseEther(AGENT_MIN_BALANCE_ETH);
} catch {
  throw new Error(`Invalid AGENT_MIN_BALANCE_ETH value: "${AGENT_MIN_BALANCE_ETH}"`);
}

const agents = createAgentContexts();
const runtimeAgents = DEMO_AGENT_ADDRESS
  ? agents.filter((agent) => agent.account.address.toLowerCase() === DEMO_AGENT_ADDRESS)
  : agents;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const farcasterPostState = {
  dayKey: '',
  successPostsToday: 0,
};
let runtimeTaskChain = Promise.resolve();
const pendingGameActivations = new Set();
const inactiveGameIds = new Set();

function normalizeGameId(gameOrId) {
  return String(gameOrId?.id || gameOrId || '').trim();
}

function isGameInactive(gameOrId) {
  const gameId = normalizeGameId(gameOrId);
  return gameId ? inactiveGameIds.has(gameId) : false;
}

function markGameInactive(gameOrId) {
  const gameId = normalizeGameId(gameOrId);
  if (gameId) {
    inactiveGameIds.add(gameId);
    pendingGameActivations.delete(gameId);
  }
}

function markGameActive(gameOrId) {
  const gameId = normalizeGameId(gameOrId);
  if (gameId) {
    inactiveGameIds.delete(gameId);
  }
}

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

function getSupportedActions(game) {
  return Array.isArray(game.supported_actions)
    ? game.supported_actions.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function getMinutesSince(timestamp, now = Date.now()) {
  const parsed = Date.parse(timestamp || '');
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.floor((now - parsed) / 60000));
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

function enqueueRuntimeTask(label, task) {
  runtimeTaskChain = runtimeTaskChain
    .catch(() => undefined)
    .then(async () => {
      console.log(`[runtime] ${label} started`);
      try {
        return await task();
      } finally {
        console.log(`[runtime] ${label} finished`);
      }
    });

  return runtimeTaskChain;
}

function scheduleGameActivation(game, reason = 'game-created') {
  const activationKey = String(game?.id || game?.contract_address || '').trim();
  if (!activationKey) {
    return {
      status: 'skipped',
      reason: 'Missing game identifier',
      queuedAt: new Date().toISOString(),
    };
  }

  markGameActive(activationKey);

  if (pendingGameActivations.has(activationKey)) {
    return {
      status: 'already-queued',
      reason,
      queuedAt: new Date().toISOString(),
    };
  }

  pendingGameActivations.add(activationKey);

  void enqueueRuntimeTask(`activate:${game.name}:${reason}`, async () => {
    try {
      if (isGameInactive(activationKey)) {
        console.log(`[runtime] Activation cancelled for ${game.name} (${reason}) because the game is inactive.`);
        return;
      }

      await ensureAgentsRegisteredOnchain([game]);
      if (isGameInactive(activationKey)) {
        console.log(`[runtime] Activation run skipped for ${game.name} because the game is inactive.`);
        return;
      }

      await runGames([game], 'run');
    } catch (error) {
      console.error(`[runtime] Activation failed for ${game.name}:`, error);
    } finally {
      pendingGameActivations.delete(activationKey);
    }
  });

  return {
    status: 'queued',
    reason,
    queuedAt: new Date().toISOString(),
  };
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

async function postToFarcaster(text) {
  if (!FARCASTER_POSTS_ENABLED) {
    console.log('Farcaster posting disabled by config');
    return null;
  }

  if (!NEYNAR_API_KEY || !FARCASTER_SIGNER_UUID) {
    console.log('Farcaster not configured, skipping post');
    console.log('Would have posted:', text);
    return null;
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
          api_key: NEYNAR_API_KEY,
          'content-type': 'application/json',
        },
      }
    );

    console.log('Posted to Farcaster:', response.data.cast.hash);
    return response.data;
  } catch (error) {
    console.error('Failed to post to Farcaster:', error.response?.data || error.message);
    return null;
  }
}

async function ensureAgentsRegisteredOnchain(games) {
  for (const game of games) {
    for (const agent of runtimeAgents) {
      try {
        const stats = await getAgentStatsOnchain(game.contract_address, agent.account.address);
        if (stats.isRegistered) {
          const desiredLimit = BigInt(String(game.daily_limit_wei || '0'));
          if (stats.dailyLimit !== desiredLimit) {
            console.log(
              `[${agent.name}] Updating onchain daily limit for ${game.name} from ${stats.dailyLimit.toString()} to ${desiredLimit.toString()} wei...`
            );
            const updated = await updateAgentLimitOnchain(agent, game.contract_address, desiredLimit);
            console.log(`[${agent.name}] Daily limit updated for ${game.name}: ${updated.hash}`);
          }

          console.log(
            `[${agent.name}] Registered for ${game.name}. Daily limit ${stats.dailyLimit.toString()} wei, today spend ${stats.todaySpend.toString()} wei.`
          );
          continue;
        }

        console.log(
          `[${agent.name}] Registering for ${game.name} with daily limit ${game.daily_limit_wei} wei...`
        );
        const registration = await registerAgentOnchain(agent, game.contract_address, game.daily_limit_wei);
        console.log(`[${agent.name}] Registration complete for ${game.name}: ${registration.hash}`);
      } catch (error) {
        console.error(`[${agent.name}] Registration check failed for ${game.name}:`, error);
      }
    }
  }
}

async function showStatus(agent, game) {
  try {
    console.log(`\n${agent.name} Status Check | ${game.name}\n`);
    const snapshot = await getPrePressSnapshot(
      agent.account.address,
      game.contract_address,
      `statusSnapshot:${game.name}:${agent.name}`
    );

    console.log(`Game: ${game.name}`);
    console.log(`Contract: ${game.contract_address}`);
    console.log(`Current Rate: ${snapshot.rate.toFixed(2)}%`);
    console.log(`Total Presses: ${snapshot.presses}`);
    console.log(`Agent Address: ${agent.account.address}`);
    console.log(`Cooldown: ${snapshot.cooldown}s`);

    if (snapshot.cooldown === 0) {
      console.log('\nReady to press!');
    } else {
      const minutes = Math.floor(snapshot.cooldown / 60);
      console.log(`\nNext press available in ${minutes} minutes`);
    }
  } catch (error) {
    console.error(`[${agent.name}] Status check error for ${game.name}:`, error);
  }
}

async function runAgentForGame(agent, game, cycleContext = null) {
  try {
    if (isGameInactive(game.id)) {
      console.log(`[${agent.name}] ${game.name} is inactive. Skipping run.`);
      return;
    }

    console.log('\n' + '='.repeat(50));
    console.log(`${agent.name} running for ${game.name}...`);
    console.log('Time:', new Date().toLocaleString());
    console.log('Agent Address:', agent.account.address);
    console.log('Contract:', game.contract_address);
    console.log('='.repeat(50) + '\n');

    if (cycleContext && cycleContext.sentTransactions >= cycleContext.maxTransactions) {
      console.log(
        `[${agent.name}] Cycle tx budget reached (${cycleContext.sentTransactions}/${cycleContext.maxTransactions}), skipping ${game.name}.`
      );
      return;
    }

    const balanceWei = await getAgentBalanceWei(agent.account.address, `balance:${agent.name}`);
    if (balanceWei < AGENT_MIN_BALANCE_WEI) {
      console.log(
        `[${agent.name}] Low ETH balance: ${balanceWei.toString()} wei (min ${AGENT_MIN_BALANCE_ETH} ETH). Skipping run.`
      );
      return;
    }

    const preSnapshot = await getPrePressSnapshot(
      agent.account.address,
      game.contract_address,
      `prePressSnapshot:${game.name}:${agent.name}`
    );
    if (preSnapshot.cooldown > 0) {
      const minutes = Math.floor(preSnapshot.cooldown / 60);
      const seconds = preSnapshot.cooldown % 60;
      console.log(`[${agent.name}] Cooldown active for ${game.name}: ${minutes}m ${seconds}s remaining`);
      console.log('Skipping this run...\n');
      return;
    }

    const skipRoll = Math.random();
    if (skipRoll < AGENT_RANDOM_SKIP_CHANCE) {
      const rollPct = (skipRoll * 100).toFixed(1);
      const thresholdPct = (AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1);
      console.log(
        `[${agent.name}] Random skip for ${game.name} (roll ${rollPct}% < threshold ${thresholdPct}%)`
      );
      return;
    }

    const actionDelayMs = randomInt(AGENT_ACTION_DELAY_MIN_MS, AGENT_ACTION_DELAY_MAX_MS);
    if (actionDelayMs > 0) {
      console.log(`[${agent.name}] Random action delay for ${game.name}: ${actionDelayMs}ms`);
      await sleep(actionDelayMs);
    }

    if (isGameInactive(game.id)) {
      console.log(`[${agent.name}] ${game.name} was stopped during delay. Aborting run.`);
      return;
    }

    const readySnapshot = await getPrePressSnapshot(
      agent.account.address,
      game.contract_address,
      `prePressAfterDelay:${game.name}:${agent.name}`
    );
    if (readySnapshot.cooldown > 0) {
      const minutes = Math.floor(readySnapshot.cooldown / 60);
      const seconds = readySnapshot.cooldown % 60;
      console.log(`[${agent.name}] Cooldown became active after delay for ${game.name}: ${minutes}m ${seconds}s`);
      return;
    }

    console.log(`[${agent.name}] ${game.name} Current Rate: ${readySnapshot.rate.toFixed(2)}%`);
    console.log(`[${agent.name}] ${game.name} Total Presses: ${readySnapshot.presses}`);

    const dailyBudget = await getDailyBudgetStatus(AGENT_DAILY_TX_MIN, AGENT_DAILY_TX_MAX);
    const actionStats = await getDailyActionStats(agent.account.address, game.id);
    const spendSnapshot = await getSpendingSnapshot(
      agent.account.address,
      game.id,
      game.daily_limit_wei
    );
    const supportedActions = getSupportedActions(game);
    const dailyFreePressLimit = Math.max(0, Number(game.daily_free_press_limit || 0));
    const dailyPaidPressLimit = Math.max(0, Number(game.daily_paid_press_limit || 0));
    const minMinutesBetweenActions = Math.max(1, Number(game.min_minutes_between_actions || 60));
    const remainingFreePresses = supportedActions.includes('press')
      ? Math.max(0, dailyFreePressLimit - actionStats.pressCount)
      : 0;
    const remainingPaidHits = supportedActions.includes('pressWithBet')
      ? Math.max(0, dailyPaidPressLimit - actionStats.paidPressCount)
      : 0;
    const minutesSinceLastAction = getMinutesSince(actionStats.lastActionAt);

    if (
      minutesSinceLastAction !== null &&
      minMinutesBetweenActions > 0 &&
      minutesSinceLastAction < minMinutesBetweenActions
    ) {
      console.log(
        `[${agent.name}] Policy cadence active for ${game.name}: ${minutesSinceLastAction}/${minMinutesBetweenActions} minutes since last action.`
      );
      return;
    }

    const allowedActions = [];
    if (remainingFreePresses > 0) {
      allowedActions.push('press');
    }
    if (remainingPaidHits > 0) {
      allowedActions.push('pressWithBet');
    }

    if (allowedActions.length === 0) {
      console.log(
        `[${agent.name}] Policy exhausted for ${game.name}: press ${actionStats.pressCount}/${dailyFreePressLimit}, paid ${actionStats.paidPressCount}/${dailyPaidPressLimit}.`
      );
      return;
    }

    console.log(
      `[${agent.name}] Policy for ${game.name}: actions=${allowedActions.join(', ')} freeRemaining=${remainingFreePresses} paidRemaining=${remainingPaidHits} spendRemainingWei=${spendSnapshot.remainingBudgetWei}`
    );

    const llmContext = {
      currentRate: readySnapshot.rate,
      totalPresses: readySnapshot.presses,
      cooldownSeconds: readySnapshot.cooldown,
      dailyTxUsed: dailyBudget.sentTransactions,
      dailyTxTarget: dailyBudget.targetTransactions,
      agentName: agent.name,
      gameName: game.name,
      gameDescription: game.description,
      policyText: game.policy_text,
      supportedActions,
      allowedActions,
      dailyPressLimit: dailyFreePressLimit,
      dailyPaidPressLimit,
      remainingFreePressesToday: remainingFreePresses,
      remainingPaidHitsToday: remainingPaidHits,
      minMinutesBetweenActions,
      minutesSinceLastAction,
      dailyLimitWei: String(game.daily_limit_wei),
      todaySpendWei: spendSnapshot.todaySpendWei,
      remainingBudgetWei: spendSnapshot.remainingBudgetWei,
    };

    const decision = await askLLM(llmContext);
    console.log('[brain]', game.name, decision.action, '-', decision.reason);
    await saveDecision(game.id, agent.account.address, decision);

    if (isGameInactive(game.id)) {
      console.log(`[${agent.name}] ${game.name} was stopped before tx submission. Aborting run.`);
      return;
    }

    if (decision.action === 'skip') {
      console.log(`[${agent.name}] Skipping ${game.name} per brain decision.`);
      return;
    }

    let txResult;
    let action = 'press';
    let betAmountWei = '0';
    let estimatedTotalSpendWei = 0n;

    if (decision.action === 'pressWithBet') {
      if (!allowedActions.includes('pressWithBet')) {
        console.log(`[${agent.name}] Brain selected pressWithBet but policy does not allow it for ${game.name}.`);
        return;
      }

      let normalizedBetWei;
      try {
        normalizedBetWei = BigInt(decision.betAmountWei || '0');
      } catch {
        console.log(`[${agent.name}] Invalid bet amount from brain for ${game.name}. Skipping.`);
        return;
      }

      if (normalizedBetWei <= 0n) {
        console.log(`[${agent.name}] Brain selected pressWithBet without a positive bet for ${game.name}. Skipping.`);
        return;
      }

      const preparedBet = await estimatePressWithBetEthCost(agent, game.contract_address, normalizedBetWei);
      estimatedTotalSpendWei = preparedBet.estimatedCostWei + normalizedBetWei;
      const spendingGuard = await checkSpendingAllowed(
        agent.account.address,
        game.id,
        game.daily_limit_wei,
        estimatedTotalSpendWei.toString()
      );
      if (!spendingGuard.allowed) {
        console.log(`[${agent.name}] ${spendingGuard.reason}`);
        return;
      }

      betAmountWei = normalizedBetWei.toString();
      action = 'pressWithBet';
      txResult = await pressWithBet(agent, game.contract_address, betAmountWei, preparedBet);
    } else if (decision.action === 'press') {
      if (!allowedActions.includes('press')) {
        console.log(`[${agent.name}] Brain selected press but policy does not allow it for ${game.name}.`);
        return;
      }

      const preparedPress = await estimatePressEthCost(agent, game.contract_address);
      estimatedTotalSpendWei = preparedPress.estimatedCostWei;
      const spendingGuard = await checkSpendingAllowed(
        agent.account.address,
        game.id,
        game.daily_limit_wei,
        estimatedTotalSpendWei.toString()
      );
      if (!spendingGuard.allowed) {
        console.log(`[${agent.name}] ${spendingGuard.reason}`);
        return;
      }

      txResult = await pressPowell(agent, game.contract_address, preparedPress);
    } else {
      console.log(`[${agent.name}] Unsupported action "${decision.action}" for ${game.name}. Skipping.`);
      return;
    }

    const { hash, receipt, maxFeePerGas } = txResult;

    if (cycleContext) {
      cycleContext.sentTransactions += 1;
      console.log(
        `[${agent.name}] Cycle tx usage: ${cycleContext.sentTransactions}/${cycleContext.maxTransactions}`
      );
    }

    await sleep(5000);

    const postSnapshot = await getPostPressSnapshot(
      game.contract_address,
      `postPressSnapshot:${game.name}:${agent.name}`
    );
    const gasSpendWei = (receipt.gasUsed || 0n) * (receipt.effectiveGasPrice || maxFeePerGas || 0n);
    const totalSpendWei = action === 'pressWithBet'
      ? gasSpendWei + BigInt(betAmountWei)
      : gasSpendWei;

    await saveTransaction(
      game.id,
      agent.account.address,
      hash,
      action,
      totalSpendWei.toString()
    );

    const updatedBudget = await getDailyBudgetStatus(AGENT_DAILY_TX_MIN, AGENT_DAILY_TX_MAX);

    console.log(`\n[${agent.name}] ${game.name} New Rate: ${postSnapshot.rate.toFixed(2)}%`);
    console.log(`[${agent.name}] ${game.name} Total Presses: ${postSnapshot.presses}`);
    console.log(
      `[${agent.name}] Daily tx usage: ${updatedBudget.sentTransactions}/${updatedBudget.targetTransactions} (${updatedBudget.dayKey})`
    );
    if (action === 'pressWithBet') {
      console.log(`[${agent.name}] Bet amount: ${betAmountWei} wei`);
    }

    const castPersona = pickRandom(CAST_PERSONAS);
    const actionLabel = action === 'pressWithBet' ? 'pressWithBet()' : 'press()';
    const messages = [
      `Agent ${castPersona} landed a hit in ${game.name}.\n\nRate: ${readySnapshot.rate.toFixed(2)}% -> ${postSnapshot.rate.toFixed(2)}%\nTotal hits: ${postSnapshot.presses}\n\n${APP_URL}`,
      `${castPersona} reports mission success in ${game.name}.\n\nRate now: ${postSnapshot.rate.toFixed(2)}%\nPress count: ${postSnapshot.presses}\n\n${APP_URL}`,
      `${castPersona} executed ${actionLabel} in ${game.name}.\n\nRate: ${readySnapshot.rate.toFixed(2)}% -> ${postSnapshot.rate.toFixed(2)}%\nHit #${postSnapshot.presses}\n\n${APP_URL}`,
    ];

    if (!FARCASTER_POSTS_ENABLED) {
      console.log('Skipping Farcaster post (disabled)');
    } else if (!canPostSuccessToFarcaster()) {
      console.log('Skipping Farcaster post (daily success post limit reached)');
    } else {
      const postResult = await postToFarcaster(pickRandom(messages));
      if (postResult) {
        markSuccessPostToFarcaster();
      }
    }

    console.log(`\n[${agent.name}] ${game.name} run completed successfully!\n`);
  } catch (error) {
    console.error(`[${agent.name}] Agent error for ${game.name}:`, error);

    if (isInsufficientFundsError(error)) {
      console.log(`[${agent.name}] Insufficient ETH for gas. Top up this wallet to resume actions.`);
    } else if (String(error?.message || '').includes('cooldown')) {
      console.log('Cooldown error - this is normal, will try next hour');
    } else {
      console.log('Skipping Farcaster error post (success-only mode)');
    }
  }
}

async function runGames(games, mode) {
  if (games.length === 0) {
    console.log('No active games found.');
    return;
  }

  const dailyBudget = await getDailyBudgetStatus(AGENT_DAILY_TX_MIN, AGENT_DAILY_TX_MAX);
  const dailyRemaining = Math.max(0, dailyBudget.targetTransactions - dailyBudget.sentTransactions);
  const cycleContext = mode === 'run'
    ? {
      sentTransactions: 0,
      maxTransactions: Math.min(AGENT_CYCLE_MAX_TRANSACTIONS, dailyRemaining),
    }
    : null;

  if (mode === 'run') {
    console.log(
      `Daily tx budget: ${dailyBudget.sentTransactions}/${dailyBudget.targetTransactions} used (${dailyBudget.dayKey}), remaining ${dailyRemaining}`
    );
    console.log(`Run cycle tx budget: ${cycleContext.maxTransactions} tx max`);
    if (cycleContext.maxTransactions <= 0) {
      console.log('Daily tx cap reached. Skipping this cycle.');
      return;
    }
  }

  for (const game of games) {
    if (isGameInactive(game.id)) {
      console.log(`${game.name} is inactive. Skipping game loop.`);
      continue;
    }

    if (mode === 'run' && cycleContext.sentTransactions >= cycleContext.maxTransactions) {
      console.log(
        `Cycle tx budget reached (${cycleContext.sentTransactions}/${cycleContext.maxTransactions}). Ending this cycle early.`
      );
      break;
    }

    for (let index = 0; index < runtimeAgents.length; index += 1) {
      const agent = runtimeAgents[index];

      if (isGameInactive(game.id)) {
        console.log(`${game.name} became inactive during the cycle. Stopping loop.`);
        break;
      }

      if (mode === 'run' && cycleContext.sentTransactions >= cycleContext.maxTransactions) {
        console.log(
          `Cycle tx budget reached (${cycleContext.sentTransactions}/${cycleContext.maxTransactions}). Ending this cycle early.`
        );
        break;
      }

      try {
        if (mode === 'status') {
          await showStatus(agent, game);
        } else {
          await runAgentForGame(agent, game, cycleContext);
        }
      } catch (error) {
        console.error(`[${agent.name}] Unhandled loop error for ${game.name}:`, error);
      }

      const shouldWait = index < runtimeAgents.length - 1 && AGENT_RUN_STAGGER_MS > 0;
      if (shouldWait) {
        console.log(`Waiting ${AGENT_RUN_STAGGER_MS}ms before next agent...`);
        await sleep(AGENT_RUN_STAGGER_MS);
      }
    }
  }
}

async function runAllGames(mode) {
  const games = await getActiveGames();
  await runGames(games, mode);
}

async function startAgent() {
  await initDb();
  if (DEMO_AGENT_ADDRESS && runtimeAgents.length === 0) {
    throw new Error(`DEMO_AGENT_ADDRESS ${DEMO_AGENT_ADDRESS} does not match any configured agent.`);
  }

  await startApiServer(runtimeAgents, {
    onGameCreated: async (game) => scheduleGameActivation(game, 'game-created'),
    onGameUpdated: async (game, previousGame) => {
      if (!game?.active) {
        markGameInactive(game.id);
        return {
          status: 'inactive',
          reason: 'Game is not active',
          queuedAt: new Date().toISOString(),
        };
      }

      markGameActive(game.id);

      const shouldResync =
        !previousGame?.active ||
        String(previousGame?.daily_limit_wei || '') !== String(game.daily_limit_wei || '');

      if (!shouldResync) {
        return {
          status: 'noop',
          reason: 'No runtime sync required',
          queuedAt: new Date().toISOString(),
        };
      }

      return scheduleGameActivation(game, 'game-updated');
    },
  });

  console.log('\nMulti-Game Agent Started!\n');
  console.log(`Scheduler cron: ${AGENT_POLL_CRON}`);
  console.log('Agents configured:', runtimeAgents.length);
  if (DEMO_AGENT_ADDRESS) {
    console.log(`Demo agent mode: ${DEMO_AGENT_ADDRESS}`);
  }
  for (const agent of runtimeAgents) {
    console.log(`Agent ${agent.name}: ${agent.account.address}`);
  }

  const uniqueAgentCount = new Set(runtimeAgents.map((agent) => agent.account.address.toLowerCase())).size;
  if (uniqueAgentCount !== runtimeAgents.length) {
    console.log('WARNING: Duplicate agent addresses detected. Use unique private keys for true multi-agent behavior.');
  }

  console.log('Farcaster posting:', FARCASTER_POSTS_ENABLED ? 'enabled' : 'disabled');
  console.log('Farcaster posting mode:', 'success-only');
  console.log('Farcaster success post limit:', `${FARCASTER_MAX_SUCCESS_POSTS_PER_DAY} per UTC day`);
  console.log('Builder attribution:', TX_DATA_SUFFIX ? 'enabled' : 'disabled');
  console.log('Agent stagger:', `${AGENT_RUN_STAGGER_MS}ms`);
  console.log('Random skip chance:', `${(AGENT_RANDOM_SKIP_CHANCE * 100).toFixed(1)}%`);
  console.log('Random action delay range:', `${AGENT_ACTION_DELAY_MIN_MS}-${AGENT_ACTION_DELAY_MAX_MS}ms`);
  console.log('Cycle transaction budget:', `${AGENT_CYCLE_MAX_TRANSACTIONS} tx`);
  console.log('Daily transaction target range:', `${AGENT_DAILY_TX_MIN}-${AGENT_DAILY_TX_MAX} tx`);
  console.log('Min agent gas balance:', `${AGENT_MIN_BALANCE_ETH} ETH`);
  console.log('Run immediately on startup:', RUN_ON_START ? 'enabled' : 'disabled');
  console.log('\n' + '='.repeat(50) + '\n');

  if (process.argv.includes('--status')) {
    await runAllGames('status');
    process.exit(0);
  }

  const startupGames = await getActiveGames();
  await ensureAgentsRegisteredOnchain(startupGames);

  if (process.argv.includes('--once')) {
    console.log('Running in test mode (one-time execution)');
    await enqueueRuntimeTask('once-run', async () => {
      await runAllGames('run');
    });
    process.exit(0);
  }

  if (RUN_ON_START) {
    await enqueueRuntimeTask('startup-run', async () => {
      await runAllGames('run');
    });
  } else {
    console.log('Startup run skipped. Waiting for next scheduled cycle.');
  }

  cron.schedule(AGENT_POLL_CRON, async () => {
    await enqueueRuntimeTask(`cron:${new Date().toISOString()}`, async () => {
      await runAllGames('run');
    });
  });

  console.log(`Scheduler active. Agents will run on cron ${AGENT_POLL_CRON}.`);
  console.log('Press Ctrl+C to stop\n');
}

startAgent().catch(console.error);
