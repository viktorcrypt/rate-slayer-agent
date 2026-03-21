import {
  concatHex,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  numberToHex,
  parseAbi,
  stringToHex,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const AGENT_PRIVATE_KEYS = (process.env.AGENT_PRIVATE_KEYS || '')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const AGENT_NAMES = (process.env.AGENT_NAMES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const BASE_RPC_URL_READ = process.env.BASE_RPC_URL_READ || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const BASE_RPC_URL_WRITE = process.env.BASE_RPC_URL_WRITE || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 5);
const RPC_BASE_DELAY_MS = Number(process.env.RPC_BASE_DELAY_MS || 500);
const RPC_MAX_DELAY_MS = Number(process.env.RPC_MAX_DELAY_MS || 8000);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 200);
const BUILDER_CODE = process.env.BUILDER_CODE?.trim();
const BUILDER_CODES = (process.env.BUILDER_CODES || '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);
const BUILDER_DATA_SUFFIX = process.env.BUILDER_DATA_SUFFIX?.trim();
const ERC8021_DATA_SUFFIX = '0x80218021802180218021802180218021';

export const CONTRACT_ABI = parseAbi([
  'function rateBps() view returns (uint256)',
  'function totalPresses() view returns (uint256)',
  'function timeUntilNextPress(address user) view returns (uint256)',
  'function getCurrentRate() view returns (uint256)',
  'function press() external',
  'function pressWithBet() external payable',
  'function registerAgent(uint256 dailyLimitWei) external',
  'function updateAgentLimit(uint256 newDailyLimitWei) external',
  'function getAgentStats(address agent) view returns (uint256 dailyLimit, uint256 currentTodaySpend, uint256 currentTotalSpend, uint256 currentTotalPresses, bool isRegistered)',
  'function isRegisteredAgent(address) view returns (bool)',
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
    numberToHex(0, { size: 1 }),
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TX_DATA_SUFFIX = resolveTxDataSuffix();

export const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL_READ),
});

export async function withRpcRetry(fn, label) {
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

export function createAgentContexts() {
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

export async function getAgentBalanceWei(address, label = 'agentBalance') {
  return withRpcRetry(() => publicClient.getBalance({ address }), label);
}

export async function getPrePressSnapshot(address, contractAddress, label = 'prePressSnapshot') {
  const [rate, presses, cooldown] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'totalPresses',
        },
        {
          address: contractAddress,
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

export async function getPostPressSnapshot(contractAddress, label = 'postPressSnapshot') {
  const [rate, presses] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: contractAddress,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: contractAddress,
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

async function estimatePreparedCall(agent, contractAddress, functionName, value = 0n) {
  const simulation = await withRpcRetry(
    () => publicClient.simulateContract({
      account: agent.account,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName,
      ...(value > 0n ? { value } : {}),
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    }),
    `simulate:${functionName}:${agent.name}`
  );

  const feeEstimate = await withRpcRetry(
    () => publicClient.estimateFeesPerGas(),
    `estimateFees:${agent.name}`
  );

  const gas = simulation.request.gas ?? 0n;
  const maxFeePerGas =
    simulation.request.maxFeePerGas ??
    feeEstimate.maxFeePerGas ??
    feeEstimate.gasPrice ??
    feeEstimate.maxPriorityFeePerGas ??
    0n;
  const estimatedCostWei = gas * maxFeePerGas;

  return {
    request: simulation.request,
    gas,
    maxFeePerGas,
    estimatedCostWei,
    estimatedCostEth: formatEther(estimatedCostWei),
  };
}

export async function estimatePressEthCost(agent, contractAddress) {
  return estimatePreparedCall(agent, contractAddress, 'press');
}

export async function estimatePressWithBetEthCost(agent, contractAddress, betAmountWei) {
  return estimatePreparedCall(agent, contractAddress, 'pressWithBet', BigInt(betAmountWei));
}

export async function pressPowell(agent, contractAddress, preparedPress = null) {
  console.log(`[${agent.name}] Attempting to press Powell on ${contractAddress}...`);

  const prepared = preparedPress || await estimatePreparedCall(agent, contractAddress, 'press');
  const hash = await withRpcRetry(
    () => agent.walletClient.writeContract(prepared.request),
    `writePress:${agent.name}`
  );
  console.log(`[${agent.name}] Transaction sent:`, hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    `waitForReceipt:${agent.name}`
  );
  console.log(`[${agent.name}] Transaction confirmed!`);

  return {
    hash,
    receipt,
    estimatedCostWei: prepared.estimatedCostWei,
    estimatedCostEth: prepared.estimatedCostEth,
    maxFeePerGas: prepared.maxFeePerGas,
  };
}

export async function pressWithBet(agent, contractAddress, betAmountWei, preparedPressWithBet = null) {
  const betWei = BigInt(betAmountWei);
  console.log(`[${agent.name}] Attempting to pressWithBet on ${contractAddress} with ${betWei.toString()} wei...`);

  const prepared = preparedPressWithBet || await estimatePreparedCall(agent, contractAddress, 'pressWithBet', betWei);
  const hash = await withRpcRetry(
    () => agent.walletClient.writeContract({
      ...prepared.request,
      value: betWei,
    }),
    `writePressWithBet:${agent.name}`
  );
  console.log(`[${agent.name}] Bet transaction sent:`, hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    `waitForBetReceipt:${agent.name}`
  );
  console.log(`[${agent.name}] Bet transaction confirmed!`);

  return {
    hash,
    receipt,
    betAmountWei: betWei.toString(),
    estimatedCostWei: prepared.estimatedCostWei,
    estimatedCostEth: prepared.estimatedCostEth,
    maxFeePerGas: prepared.maxFeePerGas,
  };
}

export async function updateAgentLimitOnchain(agent, contractAddress, newDailyLimitWei) {
  const limitWei = BigInt(newDailyLimitWei);
  const simulation = await withRpcRetry(
    () => publicClient.simulateContract({
      account: agent.account,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'updateAgentLimit',
      args: [limitWei],
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    }),
    `simulateUpdateAgentLimit:${agent.name}`
  );

  const hash = await withRpcRetry(
    () => agent.walletClient.writeContract(simulation.request),
    `writeUpdateAgentLimit:${agent.name}`
  );
  console.log(`[${agent.name}] Agent limit update transaction sent:`, hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    `waitForUpdateAgentLimitReceipt:${agent.name}`
  );
  console.log(`[${agent.name}] Agent limit update confirmed!`);

  return {
    hash,
    receipt,
  };
}

export async function registerAgentOnchain(agent, contractAddress, dailyLimitWei) {
  const limitWei = BigInt(dailyLimitWei);
  const simulation = await withRpcRetry(
    () => publicClient.simulateContract({
      account: agent.account,
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'registerAgent',
      args: [limitWei],
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    }),
    `simulateRegisterAgent:${agent.name}`
  );

  const hash = await withRpcRetry(
    () => agent.walletClient.writeContract(simulation.request),
    `writeRegisterAgent:${agent.name}`
  );
  console.log(`[${agent.name}] Registration transaction sent:`, hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    `waitForRegisterReceipt:${agent.name}`
  );
  console.log(`[${agent.name}] Registration transaction confirmed!`);

  return {
    hash,
    receipt,
  };
}

export async function getAgentStatsOnchain(contractAddress, address) {
  const [dailyLimit, currentTodaySpend, currentTotalSpend, currentTotalPresses, isRegistered] = await withRpcRetry(
    () => publicClient.readContract({
      address: contractAddress,
      abi: CONTRACT_ABI,
      functionName: 'getAgentStats',
      args: [address],
    }),
    `getAgentStats:${contractAddress}:${address}`
  );

  return {
    dailyLimit,
    todaySpend: currentTodaySpend,
    totalSpend: currentTotalSpend,
    totalPresses: currentTotalPresses,
    isRegistered,
  };
}
