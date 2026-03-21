import { formatEther, parseEther } from 'viem';

export const DEFAULT_DAILY_LIMIT_ETH = '0.00001';
export const DEFAULT_FREE_PRESS_LIMIT = '10';
export const DEFAULT_PAID_PRESS_LIMIT = '1';
export const DEFAULT_MIN_CADENCE_MINUTES = '60';
export const BASESCAN_TX_ROOT = 'https://basescan.org/tx/';

export function createEmptyState() {
  return {
    games: [],
    recentDecisions: [],
    recentTransactions: [],
    dailySpending: [],
    agents: [],
  };
}

export function createSetupState() {
  return {
    contractAddress: '',
    name: '',
    description: '',
    operatorDirective: '',
    dailyLimitEth: DEFAULT_DAILY_LIMIT_ETH,
    dailyFreePressLimit: DEFAULT_FREE_PRESS_LIMIT,
    dailyPaidPressLimit: DEFAULT_PAID_PRESS_LIMIT,
    minMinutesBetweenActions: DEFAULT_MIN_CADENCE_MINUTES,
    selectedActions: [],
    inspection: null,
    activation: null,
  };
}

export function normalizeState(raw) {
  const empty = createEmptyState();
  if (!raw || typeof raw !== 'object') {
    return empty;
  }

  return {
    games: Array.isArray(raw.games) ? raw.games : [],
    recentDecisions: Array.isArray(raw.recentDecisions) ? raw.recentDecisions : [],
    recentTransactions: Array.isArray(raw.recentTransactions) ? raw.recentTransactions : [],
    dailySpending: Array.isArray(raw.dailySpending) ? raw.dailySpending : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
  };
}

export async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

export async function fetchDashboardState(stateEndpoint) {
  return normalizeState(await fetchJson(stateEndpoint, { cache: 'no-store' }));
}

export function formatTimestamp(value) {
  if (!value) {
    return 'No timestamp';
  }

  return new Date(value).toLocaleString();
}

export function formatClock(value) {
  if (!value) {
    return '--:--:--';
  }

  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatConfidence(confidence) {
  return `${(Math.max(0, Math.min(1, Number(confidence || 0))) * 100).toFixed(0)}%`;
}

export function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }

  return `${Number(value).toFixed(2)}%`;
}

export function formatEthCompact(weiValue) {
  try {
    const ethValue = Number(formatEther(BigInt(String(weiValue || '0'))));
    if (!Number.isFinite(ethValue) || ethValue <= 0) {
      return '0 ETH';
    }

    if (ethValue >= 1) {
      return `${ethValue.toFixed(4)} ETH`;
    }

    return `${ethValue.toFixed(6)} ETH`;
  } catch {
    return '0 ETH';
  }
}

export function truncateHash(hash) {
  if (!hash || hash.length < 14) {
    return hash || 'unknown';
  }

  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

export function truncateAddress(address) {
  if (!address || address.length < 14) {
    return address || 'unknown';
  }

  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

export function buildSpendKey(gameId, agentAddress) {
  return `${String(gameId || '')}:${String(agentAddress || '').toLowerCase()}`;
}

export function buildSpendMap(state) {
  const byKey = new Map();

  for (const row of state.dailySpending) {
    byKey.set(buildSpendKey(row.game_id, row.agent_address), row);
  }

  return byKey;
}

export function humanizeAction(action) {
  if (action === 'pressWithBet') {
    return 'paid hit';
  }

  if (action === 'press') {
    return 'press';
  }

  if (action === 'skip') {
    return 'skip';
  }

  return action || 'unknown';
}

export function actionToneClass(action) {
  if (action === 'pressWithBet') {
    return 'tone-alert';
  }

  if (action === 'press') {
    return 'tone-success';
  }

  return 'tone-muted';
}

export function getFocusAgentAddress(state) {
  return (
    state.recentTransactions[0]?.agent_address ||
    state.recentDecisions[0]?.agent_address ||
    state.agents[0] ||
    ''
  );
}

export function getFocusGame(state, focusAgentAddress) {
  if (!focusAgentAddress) {
    return state.games[0] || null;
  }

  const normalizedFocusAgent = focusAgentAddress.toLowerCase();
  const latestTransaction = state.recentTransactions.find(
    (item) => String(item.agent_address || '').toLowerCase() === normalizedFocusAgent
  );

  if (latestTransaction) {
    return state.games.find((game) => game.id === latestTransaction.game_id) || null;
  }

  const latestDecision = state.recentDecisions.find(
    (item) => String(item.agent_address || '').toLowerCase() === normalizedFocusAgent
  );

  if (latestDecision) {
    return state.games.find((game) => game.id === latestDecision.game_id) || null;
  }

  return state.games[0] || null;
}

export function getFocusDecision(state, focusAgentAddress, focusGameId) {
  if (!focusAgentAddress) {
    return null;
  }

  const normalizedFocusAgent = focusAgentAddress.toLowerCase();

  return (
    state.recentDecisions.find(
      (decision) => (
        String(decision.agent_address || '').toLowerCase() === normalizedFocusAgent &&
        (!focusGameId || decision.game_id === focusGameId)
      )
    ) ||
    state.recentDecisions.find(
      (decision) => String(decision.agent_address || '').toLowerCase() === normalizedFocusAgent
    ) ||
    null
  );
}

export function getFocusTransaction(state, focusAgentAddress, focusGameId) {
  if (!focusAgentAddress) {
    return null;
  }

  const normalizedFocusAgent = focusAgentAddress.toLowerCase();

  return (
    state.recentTransactions.find(
      (transaction) => (
        String(transaction.agent_address || '').toLowerCase() === normalizedFocusAgent &&
        (!focusGameId || transaction.game_id === focusGameId)
      )
    ) ||
    state.recentTransactions.find(
      (transaction) => String(transaction.agent_address || '').toLowerCase() === normalizedFocusAgent
    ) ||
    null
  );
}

export function toInteger(value, fallback = 0, min = 0) {
  const normalized = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.max(min, normalized);
}

export function parseDailyLimitWei(dailyLimitEth) {
  try {
    return parseEther(String(dailyLimitEth || '').trim()).toString();
  } catch {
    return null;
  }
}

export function buildPolicyText(setup) {
  const freePresses = toInteger(setup.dailyFreePressLimit, 0, 0);
  const paidHits = toInteger(setup.dailyPaidPressLimit, 0, 0);
  const cadence = toInteger(setup.minMinutesBetweenActions, 60, 1);
  const dailyLimitEth = String(setup.dailyLimitEth || '').trim() || '0';
  const parts = [
    `${freePresses} press per day`,
    `${paidHits} paid hit per day`,
    `do not spend more than ${dailyLimitEth} ETH per day`,
    `wait at least ${cadence} minutes between actions`,
  ];
  const operatorDirective = String(setup.operatorDirective || '').trim();

  if (operatorDirective) {
    parts.push(operatorDirective);
  }

  return parts.join(', ');
}

export function buildAgentBriefing(setup, focusAgentAddress, focusGame) {
  if (!setup.inspection) {
    return 'Feed me one verified Base contract. I will read the ABI, isolate gameplay actions, and wait for your hard spending boundaries before I move a single wei.';
  }

  const supportedActions = Array.isArray(setup.inspection.supportedActions)
    ? setup.inspection.supportedActions.map(humanizeAction).join(' and ')
    : 'no gameplay actions';

  if (setup.activation?.status === 'queued' || setup.activation?.status === 'already-queued') {
    return `Mission armed. I have a live queue slot and will start operating ${setup.name || setup.inspection.contractName || 'this contract'} within your envelope. Visible field unit: ${truncateAddress(focusAgentAddress) || 'awaiting runtime selection'}. Current live target: ${focusGame?.name || setup.name || 'pending first chain heartbeat'}.`;
  }

  return `Contract parsed. I found ${setup.inspection.functionSignatures.length} callable functions. Gameplay surface detected: ${supportedActions}. Set my free hits, paid hits, cadence, and ETH ceiling. Once you arm me, Railway will register and launch immediately without a manual restart.`;
}

export function buildClientEvent(channel, message) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function buildTerminalLines(clientEvents, state, focusAgentAddress) {
  const normalizedFocusAgent = String(focusAgentAddress || '').toLowerCase();
  const lines = [];

  for (const item of clientEvents) {
    lines.push({
      id: item.id,
      timestamp: item.timestamp,
      channel: item.channel,
      message: item.message,
    });
  }

  for (const decision of state.recentDecisions) {
    if (normalizedFocusAgent && String(decision.agent_address || '').toLowerCase() !== normalizedFocusAgent) {
      continue;
    }

    lines.push({
      id: `decision-${decision.id || `${decision.game_id}-${decision.created_at}`}`,
      timestamp: decision.created_at,
      channel: 'brain',
      message: `${decision.game_name || 'unknown game'} -> ${humanizeAction(decision.action)} | ${decision.reason || 'no reason'} | confidence ${formatConfidence(decision.confidence)}`,
    });
  }

  for (const transaction of state.recentTransactions) {
    if (normalizedFocusAgent && String(transaction.agent_address || '').toLowerCase() !== normalizedFocusAgent) {
      continue;
    }

    lines.push({
      id: `tx-${transaction.tx_hash}-${transaction.created_at}`,
      timestamp: transaction.created_at,
      channel: 'chain',
      message: `${transaction.game_name || 'unknown game'} confirmed ${humanizeAction(transaction.action)} | spent ${formatEthCompact(transaction.eth_spent)} | tx ${truncateHash(transaction.tx_hash)}`,
      href: `${BASESCAN_TX_ROOT}${transaction.tx_hash}`,
    });
  }

  return lines
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .slice(-18);
}
