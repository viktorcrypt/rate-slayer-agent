import { analyzeContractSetup, parsePolicyText } from './brain.js';

const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL?.trim() || 'https://api.etherscan.io/v2/api';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY?.trim() || process.env.BASESCAN_API_KEY?.trim() || '';
const BASE_CHAIN_ID = process.env.BASE_CHAIN_ID?.trim() || '8453';
const SUPPORTED_ACTION_ORDER = ['press', 'pressWithBet'];
const REQUIRED_RUNTIME_FUNCTIONS = [
  'getCurrentRate',
  'totalPresses',
  'timeUntilNextPress',
  'registerAgent',
  'getAgentStats',
];

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || '').trim());
}

function buildExplorerQuery(action, contractAddress) {
  const query = new URLSearchParams({
    chainid: BASE_CHAIN_ID,
    module: 'contract',
    action,
    address: contractAddress,
  });

  if (ETHERSCAN_API_KEY) {
    query.set('apikey', ETHERSCAN_API_KEY);
  }

  return `${ETHERSCAN_API_URL}?${query.toString()}`;
}

async function fetchExplorerJson(action, contractAddress) {
  const response = await fetch(buildExplorerQuery(action, contractAddress), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Explorer request failed with ${response.status}`);
  }

  const data = await response.json();
  const message = String(data?.result || data?.message || '').toLowerCase();

  if (data?.status === '0' && message && message !== 'no records found') {
    throw new Error(typeof data?.result === 'string' ? data.result : 'Explorer returned an error');
  }

  return data;
}

function normalizeAbi(abiValue) {
  if (Array.isArray(abiValue)) {
    return abiValue;
  }

  if (!abiValue || typeof abiValue !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(abiValue);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getFunctionEntries(abi) {
  if (!Array.isArray(abi)) {
    return [];
  }

  return abi.filter((entry) => entry && entry.type === 'function' && typeof entry.name === 'string');
}

function formatFunctionSignature(entry) {
  const inputs = Array.isArray(entry.inputs)
    ? entry.inputs.map((input) => input?.type || 'unknown').join(', ')
    : '';
  const suffix = entry.stateMutability === 'payable'
    ? ' payable'
    : (entry.stateMutability ? ` ${entry.stateMutability}` : '');

  return `${entry.name}(${inputs})${suffix}`;
}

function buildFallbackDescription(capabilities) {
  if (capabilities.supportedActions.includes('pressWithBet')) {
    return 'BeatPowell-style game with a free press action and an optional paid hit using ETH.';
  }

  if (capabilities.supportedActions.includes('press')) {
    return 'BeatPowell-style game with a free press action.';
  }

  return 'Base onchain game contract.';
}

function buildFallbackPolicySuggestion(capabilities) {
  const parts = [];

  if (capabilities.supportedActions.includes('press')) {
    parts.push('10 press per day');
  }

  if (capabilities.supportedActions.includes('pressWithBet')) {
    parts.push('1 paid hit per day');
  }

  parts.push('do not spend more than 0.00001 ETH per day');
  parts.push('wait at least 60 minutes between actions');

  return parts.join(', ');
}

export function detectContractCapabilities(abi) {
  const functionEntries = getFunctionEntries(abi);
  const functionNames = new Set(functionEntries.map((entry) => entry.name));
  const supportedActions = SUPPORTED_ACTION_ORDER.filter((actionName) => functionNames.has(actionName));
  const missingRequiredFunctions = REQUIRED_RUNTIME_FUNCTIONS.filter((functionName) => !functionNames.has(functionName));

  return {
    functionNames: Array.from(functionNames).sort(),
    functionSignatures: functionEntries.map(formatFunctionSignature),
    supportsPress: functionNames.has('press'),
    supportsPressWithBet: functionNames.has('pressWithBet'),
    supportsRegisterAgent: functionNames.has('registerAgent'),
    supportsAgentStats: functionNames.has('getAgentStats'),
    supportsCooldown: functionNames.has('timeUntilNextPress'),
    supportsCurrentRate: functionNames.has('getCurrentRate'),
    supportedActions,
    runtimeCompatible: supportedActions.length > 0 && missingRequiredFunctions.length === 0,
    missingRequiredFunctions,
  };
}

export async function inspectGameContract(contractAddress) {
  const normalizedAddress = String(contractAddress || '').trim();
  if (!isHexAddress(normalizedAddress)) {
    throw new Error('Contract address must be a valid 0x-prefixed Base address.');
  }

  const sourceCodeData = await fetchExplorerJson('getsourcecode', normalizedAddress);
  const sourceEntry = Array.isArray(sourceCodeData?.result) ? sourceCodeData.result[0] : null;
  const sourceVerified = Boolean(sourceEntry && sourceEntry.ABI && !String(sourceEntry.ABI).toLowerCase().includes('not verified'));
  const abi = normalizeAbi(sourceEntry?.ABI) || normalizeAbi((await fetchExplorerJson('getabi', normalizedAddress)).result);

  if (!abi) {
    throw new Error('Could not load a verified ABI for this contract from the explorer.');
  }

  const capabilities = detectContractCapabilities(abi);
  if (!capabilities.runtimeCompatible) {
    throw new Error(
      `Contract is not runtime-compatible yet. Missing required functions: ${capabilities.missingRequiredFunctions.join(', ')}`
    );
  }

  const analysis = await analyzeContractSetup({
    contractAddress: normalizedAddress,
    contractName: sourceEntry?.ContractName || '',
    supportedActions: capabilities.supportedActions,
    functionSignatures: capabilities.functionSignatures,
  });

  return {
    contractAddress: normalizedAddress,
    contractName: sourceEntry?.ContractName || analysis.nameSuggestion || `Game ${normalizedAddress.slice(0, 8)}`,
    sourceVerified,
    abiJson: JSON.stringify(abi),
    supportedActions: capabilities.supportedActions,
    functionNames: capabilities.functionNames,
    functionSignatures: capabilities.functionSignatures,
    runtimeCompatible: capabilities.runtimeCompatible,
    missingRequiredFunctions: capabilities.missingRequiredFunctions,
    description: analysis.description || buildFallbackDescription(capabilities),
    nameSuggestion: analysis.nameSuggestion || sourceEntry?.ContractName || `Game ${normalizedAddress.slice(0, 8)}`,
    operatorOptions: Array.isArray(analysis.operatorOptions) && analysis.operatorOptions.length > 0
      ? analysis.operatorOptions
      : capabilities.supportedActions.map((action) => (
        action === 'press'
          ? 'Free press via press()'
          : 'Paid hit via pressWithBet()'
      )),
    setupSummary: analysis.setupSummary || `Detected supported actions: ${capabilities.supportedActions.join(', ')}`,
    policySuggestion: analysis.policySuggestion || buildFallbackPolicySuggestion(capabilities),
  };
}

export async function parseGamePolicy(input) {
  return parsePolicyText(input);
}
