import { useEffect, useState } from 'react';

import { createPublicClient, formatEther, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

const STATE_ENDPOINT = '/api/state';
const GAMES_ENDPOINT = '/api/games';
const CONTRACT_INSPECT_ENDPOINT = '/api/contracts/inspect';
const POLICY_PARSE_ENDPOINT = '/api/policies/parse';
const BASESCAN_TX_ROOT = 'https://basescan.org/tx/';
const DEFAULT_DAILY_LIMIT_WEI = '10000000000000';
const DEFAULT_POLICY_TEXT = '10 press per day, 1 paid hit per day, do not spend more than 0.00001 ETH per day, wait at least 60 minutes between actions';
const contractAbi = parseAbi([
  'function getCurrentRate() view returns (uint256)',
]);
const publicClient = createPublicClient({
  chain: base,
  transport: http(__BASE_RPC_URL__),
});

function createEmptyState() {
  return {
    games: [],
    recentDecisions: [],
    recentTransactions: [],
    dailySpending: [],
    agents: [],
  };
}

function createSetupState() {
  return {
    contractAddress: '',
    name: '',
    description: '',
    policyText: DEFAULT_POLICY_TEXT,
    dailyLimitWei: DEFAULT_DAILY_LIMIT_WEI,
    inspection: null,
    parsedPolicy: null,
  };
}

function normalizeState(raw) {
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

async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }

  return payload;
}

async function fetchDashboardState() {
  return normalizeState(await fetchJson(STATE_ENDPOINT, { cache: 'no-store' }));
}

async function fetchGameRates(games) {
  const entries = await Promise.all(
    games.map(async (game) => {
      try {
        const rate = await publicClient.readContract({
          address: game.contract_address,
          abi: contractAbi,
          functionName: 'getCurrentRate',
        });

        return [
          game.id,
          {
            value: Number(rate) / 100,
            error: '',
          },
        ];
      } catch (error) {
        return [
          game.id,
          {
            value: null,
            error: error.message || 'Rate unavailable',
          },
        ];
      }
    })
  );

  return Object.fromEntries(entries);
}

function formatTimestamp(value) {
  if (!value) {
    return 'No timestamp';
  }

  return new Date(value).toLocaleString();
}

function formatConfidence(confidence) {
  return `${(Math.max(0, Math.min(1, Number(confidence || 0))) * 100).toFixed(0)}%`;
}

function formatRate(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }

  return `${Number(value).toFixed(2)}%`;
}

function formatEthCompact(weiValue) {
  try {
    const ethValue = Number(formatEther(BigInt(String(weiValue || '0'))));
    if (!Number.isFinite(ethValue)) {
      return '0 ETH';
    }

    if (ethValue >= 1) {
      return `${ethValue.toFixed(4)} ETH`;
    }

    if (ethValue === 0) {
      return '0 ETH';
    }

    return `${ethValue.toFixed(6)} ETH`;
  } catch {
    return '0 ETH';
  }
}

function truncateHash(hash) {
  if (!hash || hash.length < 14) {
    return hash || 'unknown';
  }

  return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
}

function truncateAddress(address) {
  if (!address || address.length < 14) {
    return address || 'unknown';
  }

  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function decisionBadgeClass(action) {
  if (action === 'pressWithBet') {
    return 'decision-bet';
  }

  if (action === 'press') {
    return 'decision-press';
  }

  return 'decision-skip';
}

function buildSpendKey(gameId, agentAddress) {
  return `${String(gameId || '')}:${String(agentAddress || '').toLowerCase()}`;
}

function buildLatestDecisionCards(state) {
  const byKey = new Map();

  for (const decision of state.recentDecisions) {
    const key = buildSpendKey(decision.game_id, decision.agent_address);
    if (!byKey.has(key)) {
      byKey.set(key, decision);
    }
  }

  return Array.from(byKey.values());
}

function buildSpendMap(state) {
  const byKey = new Map();

  for (const row of state.dailySpending) {
    byKey.set(buildSpendKey(row.game_id, row.agent_address), row);
  }

  return byKey;
}

function humanizeAction(action) {
  if (action === 'pressWithBet') {
    return 'paid hit';
  }

  if (action === 'press') {
    return 'press';
  }

  return action || 'unknown';
}

function formatActionList(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return 'No supported actions detected';
  }

  return actions.map(humanizeAction).join(', ');
}

export default function App() {
  const [data, setData] = useState({
    state: createEmptyState(),
    gameRates: {},
    error: '',
    lastUpdated: null,
    loading: true,
  });
  const [setup, setSetup] = useState(createSetupState);
  const [setupError, setSetupError] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [parsingPolicy, setParsingPolicy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadSnapshot = async () => {
    try {
      const state = await fetchDashboardState();
      const gameRates = await fetchGameRates(state.games);

      setData({
        state,
        gameRates,
        error: '',
        lastUpdated: new Date().toISOString(),
        loading: false,
      });
    } catch (error) {
      setData((previous) => ({
        ...previous,
        error: error.message || 'Failed to refresh dashboard',
        lastUpdated: new Date().toISOString(),
        loading: false,
      }));
    }
  };

  useEffect(() => {
    let active = true;

    const guardedLoad = async () => {
      try {
        const state = await fetchDashboardState();
        const gameRates = await fetchGameRates(state.games);
        if (!active) {
          return;
        }

        setData({
          state,
          gameRates,
          error: '',
          lastUpdated: new Date().toISOString(),
          loading: false,
        });
      } catch (error) {
        if (!active) {
          return;
        }

        setData((previous) => ({
          ...previous,
          error: error.message || 'Failed to refresh dashboard',
          lastUpdated: new Date().toISOString(),
          loading: false,
        }));
      }
    };

    guardedLoad();
    const intervalId = setInterval(guardedLoad, 30000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  const handleSetupFieldChange = (event) => {
    const { name, value } = event.target;
    setSetup((previous) => ({
      ...previous,
      [name]: value,
      ...(name === 'contractAddress' ? { inspection: null, parsedPolicy: null } : {}),
      ...(name === 'policyText' ? { parsedPolicy: null } : {}),
    }));
  };

  const handleInspectContract = async () => {
    setInspecting(true);
    setSetupError('');

    try {
      const inspection = await fetchJson(CONTRACT_INSPECT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractAddress: setup.contractAddress,
        }),
      });

      setSetup((previous) => ({
        ...previous,
        inspection,
        name: previous.name || inspection.nameSuggestion || '',
        description: previous.description || inspection.description || '',
        policyText: previous.policyText || inspection.policySuggestion || DEFAULT_POLICY_TEXT,
      }));
    } catch (error) {
      setSetupError(error.message || 'Failed to inspect contract');
    } finally {
      setInspecting(false);
    }
  };

  const handleParsePolicy = async () => {
    if (!setup.inspection) {
      setSetupError('Inspect the contract first.');
      return;
    }

    setParsingPolicy(true);
    setSetupError('');

    try {
      const parsedPolicy = await fetchJson(POLICY_PARSE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          policyText: setup.policyText,
          supportedActions: setup.inspection.supportedActions,
          dailyLimitWei: setup.dailyLimitWei,
          minMinutesBetweenActions: setup.parsedPolicy?.minMinutesBetweenActions || 60,
        }),
      });

      setSetup((previous) => ({
        ...previous,
        parsedPolicy,
        dailyLimitWei: parsedPolicy.dailyLimitWei,
      }));
    } catch (error) {
      setSetupError(error.message || 'Failed to parse policy');
    } finally {
      setParsingPolicy(false);
    }
  };

  const handleCreateGame = async (event) => {
    event.preventDefault();
    if (!setup.inspection) {
      setSetupError('Inspect the contract before saving the game.');
      return;
    }

    setSubmitting(true);
    setSetupError('');

    try {
      const payload = await fetchJson(GAMES_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractAddress: setup.contractAddress,
          name: setup.name,
          description: setup.description,
          policyText: setup.policyText,
          dailyLimitWei: setup.parsedPolicy?.dailyLimitWei || setup.dailyLimitWei,
          dailyFreePressLimit: setup.parsedPolicy?.dailyPressLimit,
          dailyPaidPressLimit: setup.parsedPolicy?.dailyPaidPressLimit,
          minMinutesBetweenActions: setup.parsedPolicy?.minMinutesBetweenActions || 60,
        }),
      });

      setSetup(createSetupState());
      await loadSnapshot();

      if (payload?.parsedPolicy) {
        setSetup((previous) => ({
          ...previous,
          parsedPolicy: null,
        }));
      }
    } catch (error) {
      setSetupError(error.message || 'Failed to create game');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeactivateGame = async (gameId) => {
    setSubmitting(true);
    setSetupError('');

    try {
      await fetchJson(`${GAMES_ENDPOINT}/${gameId}`, {
        method: 'DELETE',
      });

      await loadSnapshot();
    } catch (error) {
      setSetupError(error.message || 'Failed to deactivate game');
    } finally {
      setSubmitting(false);
    }
  };

  const latestDecisions = buildLatestDecisionCards(data.state);
  const spendMap = buildSpendMap(data.state);
  const gameLimitById = new Map(
    data.state.games.map((game) => [game.id, String(game.daily_limit_wei || '0')])
  );

  return (
    <div className="app-shell">
      <div className="background-orbit background-orbit-left" />
      <div className="background-orbit background-orbit-right" />

      <main className="dashboard">
        <header className="hero">
          <div>
            <p className="eyebrow">Autonomous onchain desk</p>
            <h1>Rate Slayer Control Room</h1>
            <p className="subtitle">
              Inspect a verified Base contract, turn human policy text into strict agent rules, and watch execution live.
            </p>
          </div>
          <div className="refresh-chip">
            <span className="refresh-dot" />
            Refreshing every 30s
            <strong>{data.lastUpdated ? formatTimestamp(data.lastUpdated) : 'Waiting for first refresh'}</strong>
          </div>
        </header>

        {data.error ? (
          <section className="banner banner-error">
            <strong>Refresh warning</strong>
            <span>{data.error}</span>
          </section>
        ) : null}

        {setupError ? (
          <section className="banner banner-error">
            <strong>Setup warning</strong>
            <span>{setupError}</span>
          </section>
        ) : null}

        <section className="metric-grid">
          <article className="metric-card metric-card-primary">
            <span className="metric-label">Active games</span>
            <strong className="metric-value">
              {data.loading ? 'Loading...' : data.state.games.length}
            </strong>
            <span className="metric-footnote">Stored in PostgreSQL</span>
          </article>

          <article className="metric-card">
            <span className="metric-label">Tracked agents</span>
            <strong className="metric-value">
              {data.loading ? 'Loading...' : data.state.agents.length}
            </strong>
            <span className="metric-footnote">Wallets loaded from runtime env</span>
          </article>

          <article className="metric-card">
            <span className="metric-label">Recent transactions</span>
            <strong className="metric-value">
              {data.loading ? 'Loading...' : data.state.recentTransactions.length}
            </strong>
            <span className="metric-footnote">Latest confirmed actions</span>
          </article>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Game setup</p>
              <h2>Inspect contract and configure policy</h2>
            </div>
            <span className="panel-meta">Wizard flow for the demo</span>
          </div>

          <form className="game-form" onSubmit={handleCreateGame}>
            <div className="form-grid">
              <label className="field">
                <span>Contract address</span>
                <input
                  name="contractAddress"
                  value={setup.contractAddress}
                  onChange={handleSetupFieldChange}
                  placeholder="0x..."
                  required
                />
              </label>

              <div className="field field-actions">
                <span>Inspect contract</span>
                <button
                  className="button"
                  disabled={inspecting || !setup.contractAddress}
                  onClick={handleInspectContract}
                  type="button"
                >
                  {inspecting ? 'Inspecting...' : 'Inspect'}
                </button>
              </div>

              <label className="field">
                <span>Game name</span>
                <input
                  name="name"
                  value={setup.name}
                  onChange={handleSetupFieldChange}
                  placeholder="BeatPowell V2"
                  required
                />
              </label>

              <label className="field field-wide">
                <span>Description</span>
                <textarea
                  name="description"
                  value={setup.description}
                  onChange={handleSetupFieldChange}
                  placeholder="Contract summary for the operator and LLM."
                  required
                />
              </label>

              <label className="field field-wide">
                <span>Operator policy</span>
                <textarea
                  name="policyText"
                  value={setup.policyText}
                  onChange={handleSetupFieldChange}
                  placeholder="10 press per day, 1 paid hit per day, do not spend more than 0.00001 ETH per day, wait at least 60 minutes between actions"
                  required
                />
              </label>
            </div>

            <div className="form-actions">
              <div className="button-row">
                <button
                  className="button"
                  disabled={parsingPolicy || !setup.inspection}
                  onClick={handleParsePolicy}
                  type="button"
                >
                  {parsingPolicy ? 'Parsing...' : 'Parse policy'}
                </button>
                <button className="button" disabled={submitting || !setup.inspection} type="submit">
                  {submitting ? 'Saving...' : 'Save game'}
                </button>
              </div>
              <span className="panel-meta">Inspect first, then parse or save.</span>
            </div>
          </form>

          <div className="setup-grid">
            <article className="setup-card">
              <p className="eyebrow">Detected capabilities</p>
              <h3>{setup.inspection?.contractName || 'No contract inspected yet'}</h3>
              <div className="tag-row">
                {(setup.inspection?.supportedActions || []).map((action) => (
                  <span className={`decision-badge ${decisionBadgeClass(action)}`} key={action}>
                    {humanizeAction(action)}
                  </span>
                ))}
              </div>
              <p className="body-copy">
                {setup.inspection?.setupSummary || 'Inspect a verified Base contract to see supported actions.'}
              </p>
              {setup.inspection?.operatorOptions?.length ? (
                <div className="stacked-copy">
                  {setup.inspection.operatorOptions.map((option) => (
                    <span key={option}>{option}</span>
                  ))}
                </div>
              ) : null}
            </article>

            <article className="setup-card">
              <p className="eyebrow">Parsed policy</p>
              <h3>{setup.parsedPolicy ? 'Policy ready for enforcement' : 'No parsed policy yet'}</h3>
              <div className="agent-stat-row">
                <span>Free presses/day</span>
                <strong>{setup.parsedPolicy?.dailyPressLimit ?? '--'}</strong>
              </div>
              <div className="agent-stat-row">
                <span>Paid hits/day</span>
                <strong>{setup.parsedPolicy?.dailyPaidPressLimit ?? '--'}</strong>
              </div>
              <div className="agent-stat-row">
                <span>Daily ETH limit</span>
                <strong>{setup.parsedPolicy ? formatEthCompact(setup.parsedPolicy.dailyLimitWei) : '--'}</strong>
              </div>
              <div className="agent-stat-row">
                <span>Min cadence</span>
                <strong>{setup.parsedPolicy ? `${setup.parsedPolicy.minMinutesBetweenActions} min` : '--'}</strong>
              </div>
              <div className="decision-reason">
                <span>Summary</span>
                <p>{setup.parsedPolicy?.summary || 'Parse the policy text to see the strict limits the agent will enforce.'}</p>
              </div>
            </article>

            <article className="setup-card">
              <p className="eyebrow">Function signatures</p>
              <h3>{setup.inspection ? `${setup.inspection.functionSignatures.length} functions loaded` : 'Waiting for ABI'}</h3>
              <div className="signature-list">
                {setup.inspection?.functionSignatures?.length ? (
                  setup.inspection.functionSignatures.map((signature) => (
                    <code key={signature}>{signature}</code>
                  ))
                ) : (
                  <span className="body-copy">Supported function signatures will appear here after inspection.</span>
                )}
              </div>
            </article>
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Configured games</p>
              <h2>Active game policies</h2>
            </div>
            <span className="panel-meta">{data.state.games.length} active games</span>
          </div>

          <div className="agent-grid">
            {data.state.games.length === 0 ? (
              <article className="empty-card">
                <strong>No active games</strong>
                <span>Inspect a contract and save the setup to start the demo flow.</span>
              </article>
            ) : (
              data.state.games.map((game) => {
                const rateInfo = data.gameRates[game.id] || { value: null, error: '' };

                return (
                  <article className="agent-card" key={game.id}>
                    <div className="agent-card-top">
                      <div>
                        <p className="eyebrow">{game.name}</p>
                        <h3>{truncateAddress(game.contract_address)}</h3>
                      </div>
                      <span className="decision-badge decision-press">
                        {formatRate(rateInfo.value)}
                      </span>
                    </div>

                    <div className="tag-row">
                      {(game.supported_actions || []).map((action) => (
                        <span className={`decision-badge ${decisionBadgeClass(action)}`} key={`${game.id}-${action}`}>
                          {humanizeAction(action)}
                        </span>
                      ))}
                    </div>

                    <div className="agent-stat-row">
                      <span>Free presses/day</span>
                      <strong>{game.daily_free_press_limit}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Paid hits/day</span>
                      <strong>{game.daily_paid_press_limit}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Daily ETH limit</span>
                      <strong>{formatEthCompact(game.daily_limit_wei)}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Min cadence</span>
                      <strong>{game.min_minutes_between_actions} min</strong>
                    </div>

                    <div className="decision-reason">
                      <span>Policy</span>
                      <p>{game.policy_text || 'No policy text stored.'}</p>
                    </div>

                    <div className="decision-reason">
                      <span>Description</span>
                      <p>{game.description}</p>
                    </div>

                    {rateInfo.error ? (
                      <p className="inline-warning">{rateInfo.error}</p>
                    ) : null}

                    <div className="card-actions">
                      <button
                        className="button button-danger"
                        disabled={submitting}
                        onClick={() => handleDeactivateGame(game.id)}
                        type="button"
                      >
                        Deactivate
                      </button>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Agent intelligence</p>
              <h2>Latest decision by agent and game</h2>
            </div>
            <span className="panel-meta">{latestDecisions.length} cards</span>
          </div>

          <div className="agent-grid">
            {latestDecisions.length === 0 ? (
              <article className="empty-card">
                <strong>No decisions recorded</strong>
                <span>The next completed run will insert rows into `agent_decisions`.</span>
              </article>
            ) : (
              latestDecisions.map((decision) => {
                const spend = spendMap.get(buildSpendKey(decision.game_id, decision.agent_address));
                const dailyLimitWei = spend?.daily_limit_wei || gameLimitById.get(decision.game_id) || '0';

                return (
                  <article className="agent-card" key={`${decision.game_id}-${decision.agent_address}`}>
                    <div className="agent-card-top">
                      <div>
                        <p className="eyebrow">{decision.game_name || 'Unknown game'}</p>
                        <h3>{truncateAddress(decision.agent_address)}</h3>
                      </div>
                      <span className={`decision-badge ${decisionBadgeClass(decision.action)}`}>
                        {decision.action}
                      </span>
                    </div>

                    <div className="agent-stat-row">
                      <span>Confidence</span>
                      <strong>{formatConfidence(decision.confidence)}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Bet amount</span>
                      <strong>{formatEthCompact(decision.bet_amount_wei || '0')}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Daily spending</span>
                      <strong>{formatEthCompact(spend?.total_spent_wei || '0')} / {formatEthCompact(dailyLimitWei)}</strong>
                    </div>
                    <div className="agent-stat-row">
                      <span>Recorded</span>
                      <strong>{formatTimestamp(decision.created_at)}</strong>
                    </div>

                    <div className="decision-reason">
                      <span>Reason</span>
                      <p>{decision.reason || 'No reason provided.'}</p>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Execution trail</p>
              <h2>Recent transactions</h2>
            </div>
            <span className="panel-meta">Basescan linked recent writes</span>
          </div>

          <div className="transaction-list">
            {data.state.recentTransactions.length === 0 ? (
              <article className="empty-card">
                <strong>No recent transactions</strong>
                <span>Confirmed writes will appear here after the next successful agent action.</span>
              </article>
            ) : (
              data.state.recentTransactions.map((transaction) => (
                <article className="transaction-card" key={`${transaction.tx_hash}-${transaction.created_at}`}>
                  <div>
                    <p className="eyebrow">{transaction.game_name || 'Unknown game'}</p>
                    <h3>{truncateHash(transaction.tx_hash)}</h3>
                    <p className="transaction-meta">
                      {transaction.action}
                      {' | '}
                      {truncateAddress(transaction.agent_address)}
                      {' | '}
                      {formatEthCompact(transaction.eth_spent)}
                    </p>
                  </div>

                  <div className="transaction-actions">
                    <a
                      href={`${BASESCAN_TX_ROOT}${transaction.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on Basescan
                    </a>
                    <span>{formatTimestamp(transaction.created_at)}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
