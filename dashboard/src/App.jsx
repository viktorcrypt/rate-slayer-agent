import { useEffect, useMemo, useState } from 'react';

import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

import {
  actionToneClass,
  buildClientEvent,
  buildSpendKey,
  buildSpendMap,
  buildTerminalLines,
  createEmptyState,
  createSetupState,
  fetchDashboardState,
  fetchJson,
  formatClock,
  formatConfidence,
  formatEthCompact,
  formatRate,
  formatTimestamp,
  getFocusAgentAddress,
  getFocusDecision,
  getFocusGame,
  getFocusTransaction,
  humanizeAction,
  parseDailyLimitWei,
  toInteger,
  truncateAddress,
  truncateHash,
} from './dashboard-lib.js';

const STATE_ENDPOINT = '/api/state';
const GAMES_ENDPOINT = '/api/games';
const CONTRACT_INSPECT_ENDPOINT = '/api/contracts/inspect';
const contractAbi = parseAbi([
  'function getCurrentRate() view returns (uint256)',
]);
const publicClient = createPublicClient({
  chain: base,
  transport: http(__BASE_RPC_URL__),
});

async function fetchGameRates(games) {
  const entries = await Promise.all(
    games.map(async (game) => {
      try {
        const rate = await publicClient.readContract({
          address: game.contract_address,
          abi: contractAbi,
          functionName: 'getCurrentRate',
        });

        return [game.id, { value: Number(rate) / 100, error: '' }];
      } catch (error) {
        return [game.id, { value: null, error: error.message || 'Rate unavailable' }];
      }
    })
  );

  return Object.fromEntries(entries);
}

function buildSelectedPolicyText(setup) {
  const selectedActions = Array.isArray(setup.selectedActions) ? setup.selectedActions : [];
  const parts = [];

  if (selectedActions.includes('press')) {
    parts.push(`${toInteger(setup.dailyFreePressLimit, 0, 0)} press per day`);
  }

  if (selectedActions.includes('pressWithBet')) {
    parts.push(`${toInteger(setup.dailyPaidPressLimit, 0, 0)} paid hit per day`);
  }

  parts.push(`do not spend more than ${String(setup.dailyLimitEth || '').trim() || '0'} ETH per day`);
  parts.push(`wait at least ${toInteger(setup.minMinutesBetweenActions, 60, 1)} minutes between actions`);

  return parts.join(', ');
}

function actionOptionText(action) {
  if (action === 'pressWithBet') {
    return 'pressWithBet()';
  }

  if (action === 'press') {
    return 'press()';
  }

  return action;
}

function actionOptionHint(action, inspection) {
  if (action === 'pressWithBet') {
    return 'paid hit';
  }

  if (action === 'press') {
    return 'free hit';
  }

  if (inspection?.supportedActions?.includes(action)) {
    return 'runtime';
  }

  return 'abi';
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
  const [submitting, setSubmitting] = useState(false);
  const [clientEvents, setClientEvents] = useState(() => ([
    buildClientEvent('system', 'ready: paste verified contract address'),
  ]));

  const appendClientEvent = (channel, message) => {
    setClientEvents((previous) => [...previous.slice(-24), buildClientEvent(channel, message)]);
  };

  const loadSnapshot = async () => {
    try {
      const state = await fetchDashboardState(STATE_ENDPOINT);
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
        const state = await fetchDashboardState(STATE_ENDPOINT);
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
      ...(name === 'contractAddress'
        ? {
          inspection: null,
          activation: null,
          selectedActions: [],
        }
        : {}),
    }));
  };

  const handleInspectContract = async () => {
    setInspecting(true);
    setSetupError('');
    appendClientEvent('operator', `inspect ${truncateAddress(setup.contractAddress)}`);

    try {
      const inspection = await fetchJson(CONTRACT_INSPECT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress: setup.contractAddress }),
      });

      setSetup((previous) => ({
        ...previous,
        inspection,
        activation: null,
        selectedActions: inspection.runtimeCompatible && Array.isArray(inspection.supportedActions)
          ? [...inspection.supportedActions]
          : [],
      }));

      appendClientEvent(
        'system',
        `abi loaded: ${inspection.functionSignatures.length} functions | ${inspection.runtimeCompatible ? 'runtime ready' : 'inspect only'}`
      );
    } catch (error) {
      setSetupError(error.message || 'Failed to inspect contract');
      appendClientEvent('system', `inspect failed: ${error.message || 'unknown error'}`);
    } finally {
      setInspecting(false);
    }
  };

  const toggleAction = (action) => {
    setSetup((previous) => {
      const current = new Set(previous.selectedActions || []);
      if (current.has(action)) {
        current.delete(action);
      } else {
        current.add(action);
      }

      return {
        ...previous,
        selectedActions: Array.from(current),
        activation: null,
      };
    });
  };

  const handleActivateAgent = async (event) => {
    event.preventDefault();

    if (!setup.inspection) {
      setSetupError('Inspect contract first.');
      return;
    }

    if (!setup.selectedActions.length) {
      setSetupError('Choose at least one action.');
      return;
    }

    const dailyLimitWei = parseDailyLimitWei(setup.dailyLimitEth);
    if (!dailyLimitWei) {
      setSetupError('Invalid ETH limit.');
      return;
    }

    const freePressLimit = setup.selectedActions.includes('press')
      ? toInteger(setup.dailyFreePressLimit, 0, 0)
      : 0;
    const paidPressLimit = setup.selectedActions.includes('pressWithBet')
      ? toInteger(setup.dailyPaidPressLimit, 0, 0)
      : 0;
    const cadence = toInteger(setup.minMinutesBetweenActions, 60, 1);
    const policyText = buildSelectedPolicyText(setup);

    setSubmitting(true);
    setSetupError('');
    appendClientEvent('operator', `arm ${policyText}`);

    try {
      const payload = await fetchJson(GAMES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractAddress: setup.contractAddress,
          name: setup.inspection.nameSuggestion || setup.inspection.contractName,
          description: setup.inspection.description,
          policyText,
          dailyLimitWei,
          dailyFreePressLimit: freePressLimit,
          dailyPaidPressLimit: paidPressLimit,
          minMinutesBetweenActions: cadence,
        }),
      });

      setSetup((previous) => ({
        ...previous,
        activation: payload.activation || { status: 'queued', queuedAt: new Date().toISOString() },
      }));

      appendClientEvent(
        'system',
        `launch ${payload.activation?.status || 'queued'}${payload.activation?.reason ? ` | ${payload.activation.reason}` : ''}`
      );

      await loadSnapshot();
      window.setTimeout(() => {
        void loadSnapshot();
      }, 5000);
    } catch (error) {
      setSetupError(error.message || 'Failed to arm agent');
      appendClientEvent('system', `launch failed: ${error.message || 'unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const focusAgentAddress = getFocusAgentAddress(data.state);
  const focusGame = getFocusGame(data.state, focusAgentAddress);
  const focusDecision = getFocusDecision(data.state, focusAgentAddress, focusGame?.id);
  const focusTransaction = getFocusTransaction(data.state, focusAgentAddress, focusGame?.id);
  const spendMap = buildSpendMap(data.state);
  const focusSpend = focusGame && focusAgentAddress
    ? spendMap.get(buildSpendKey(focusGame.id, focusAgentAddress))
    : null;
  const focusRate = focusGame ? data.gameRates[focusGame.id] : null;
  const terminalLines = buildTerminalLines(clientEvents, data.state, focusAgentAddress);
  const selectedActions = setup.selectedActions || [];
  const policyPreview = useMemo(() => buildSelectedPolicyText(setup), [setup]);
  const visibleActions = useMemo(() => {
    if (!setup.inspection) {
      return [];
    }

    if (Array.isArray(setup.inspection.availableActions) && setup.inspection.availableActions.length > 0) {
      return setup.inspection.availableActions;
    }

    if (Array.isArray(setup.inspection.functionNames)) {
      return setup.inspection.functionNames;
    }

    return [];
  }, [setup.inspection]);

  return (
    <div className="terminal-shell">
      <div className="terminal-noise" />

      <main className="terminal-layout">
        <section className="terminal-stage">
          <div className="stage-bar">
            <span>RATESLAYER GAMING AGENT</span>
            <span>{data.lastUpdated ? formatClock(data.lastUpdated) : 'booting'}</span>
          </div>

          <form className="stage-window" onSubmit={handleActivateAgent}>
            <div className="prompt-row">
              <span className="prompt-sign">&gt;</span>
              <input
                name="contractAddress"
                value={setup.contractAddress}
                onChange={handleSetupFieldChange}
                placeholder="paste verified game contract"
                required
              />
              <button
                className="terminal-button"
                disabled={inspecting || !setup.contractAddress}
                onClick={handleInspectContract}
                type="button"
              >
                {inspecting ? 'loading' : 'inspect'}
              </button>
            </div>

            {data.error ? <div className="inline-alert">{data.error}</div> : null}
            {setupError ? <div className="inline-alert">{setupError}</div> : null}

            {setup.inspection ? (
              <>
                <div className="subhead-row">
                  <span>{setup.inspection.contractName || 'verified contract'}</span>
                  <span>{setup.inspection.functionSignatures.length} functions</span>
                </div>

                <div className="stage-columns">
                  <div className="block">
                    <div className="block-label">ABI</div>
                    <div className="function-list">
                      {setup.inspection.functionSignatures.map((signature) => (
                        <code key={signature}>{signature}</code>
                      ))}
                    </div>
                  </div>

                  <div className="block">
                    <div className="block-label">Actions</div>
                    <div className="action-list">
                      {visibleActions.map((action) => {
                        const active = selectedActions.includes(action);
                        return (
                          <button
                            className={`action-chip ${active ? 'is-active' : ''}`}
                            key={action}
                            onClick={() => toggleAction(action)}
                            type="button"
                          >
                            <span>{actionOptionText(action)}</span>
                            <small>{actionOptionHint(action, setup.inspection)}</small>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {!setup.inspection.runtimeCompatible ? (
                  <div className="inspect-note">
                    inspect only | missing: {setup.inspection.missingRequiredFunctions.join(', ')}
                  </div>
                ) : null}

                {setup.inspection.runtimeCompatible && selectedActions.length > 0 ? (
                  <div className="limits-panel">
                    <div className="block-label">Limits</div>
                    <div className="limit-grid">
                      {selectedActions.includes('press') ? (
                        <label className="limit-field">
                          <span>press / day</span>
                          <input
                            name="dailyFreePressLimit"
                            value={setup.dailyFreePressLimit}
                            onChange={handleSetupFieldChange}
                            placeholder="10"
                          />
                        </label>
                      ) : null}

                      {selectedActions.includes('pressWithBet') ? (
                        <label className="limit-field">
                          <span>paid / day</span>
                          <input
                            name="dailyPaidPressLimit"
                            value={setup.dailyPaidPressLimit}
                            onChange={handleSetupFieldChange}
                            placeholder="1"
                          />
                        </label>
                      ) : null}

                      <label className="limit-field">
                        <span>ETH / day</span>
                        <input
                          name="dailyLimitEth"
                          value={setup.dailyLimitEth}
                          onChange={handleSetupFieldChange}
                          placeholder="0.00001"
                        />
                      </label>

                      <label className="limit-field">
                        <span>minutes between</span>
                        <input
                          name="minMinutesBetweenActions"
                          value={setup.minMinutesBetweenActions}
                          onChange={handleSetupFieldChange}
                          placeholder="60"
                        />
                      </label>
                    </div>

                    <div className="launch-row">
                      <div className="policy-line">{policyPreview}</div>
                      <button className="terminal-button terminal-button-strong" disabled={submitting} type="submit">
                        {submitting ? 'arming' : 'launch'}
                      </button>
                    </div>

                    {setup.activation ? (
                      <div className="launch-status">
                        <span>{setup.activation.status}</span>
                        <small>{setup.activation.queuedAt ? formatTimestamp(setup.activation.queuedAt) : ''}</small>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </form>
        </section>

        <aside className="activity-window">
          <div className="stage-bar">
            <span>activity</span>
            <span>{focusAgentAddress ? truncateAddress(focusAgentAddress) : 'no active unit'}</span>
          </div>

          <div className="activity-head">
            <div className="activity-stat">
              <span>game</span>
              <strong>{focusGame?.name || 'waiting'}</strong>
            </div>
            <div className="activity-stat">
              <span>rate</span>
              <strong>{formatRate(focusRate?.value)}</strong>
            </div>
            <div className="activity-stat">
              <span>last</span>
              <strong className={actionToneClass(focusDecision?.action)}>
                {focusDecision ? humanizeAction(focusDecision.action) : 'idle'}
              </strong>
            </div>
            <div className="activity-stat">
              <span>spent</span>
              <strong>
                {focusSpend
                  ? `${formatEthCompact(focusSpend.total_spent_wei)} / ${formatEthCompact(focusSpend.daily_limit_wei)}`
                  : '--'}
              </strong>
            </div>
          </div>

          <div className="micro-feed">
            {focusDecision ? (
              <div className="micro-card">
                <span>reason</span>
                <strong>{focusDecision.reason}</strong>
                <small>{formatConfidence(focusDecision.confidence)}</small>
              </div>
            ) : null}

            {focusTransaction ? (
              <a className="micro-card micro-link" href={`https://basescan.org/tx/${focusTransaction.tx_hash}`} rel="noreferrer" target="_blank">
                <span>last tx</span>
                <strong>{truncateHash(focusTransaction.tx_hash)}</strong>
                <small>{formatTimestamp(focusTransaction.created_at)}</small>
              </a>
            ) : null}
          </div>

          <div className="log-window">
            {terminalLines.length === 0 ? (
              <div className="log-empty">no activity yet</div>
            ) : (
              terminalLines.map((line) => (
                <div className="log-line" key={line.id}>
                  <span className="log-time">{formatClock(line.timestamp)}</span>
                  <span className={`log-channel log-channel-${line.channel}`}>{line.channel}</span>
                  {line.href ? (
                    <a className="log-message" href={line.href} rel="noreferrer" target="_blank">
                      {line.message}
                    </a>
                  ) : (
                    <span className="log-message">{line.message}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
