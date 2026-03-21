import { useEffect, useState } from 'react';

import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

import {
  actionToneClass,
  buildAgentBriefing,
  buildClientEvent,
  buildPolicyText,
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
    buildClientEvent('system', 'Terminal online. Waiting for a verified Base contract.'),
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
        ? { inspection: null, activation: null, name: '', description: '' }
        : { activation: null }),
    }));
  };

  const handleInspectContract = async () => {
    setInspecting(true);
    setSetupError('');
    appendClientEvent('operator', `Inspection requested for ${truncateAddress(setup.contractAddress)}`);

    try {
      const inspection = await fetchJson(CONTRACT_INSPECT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractAddress: setup.contractAddress }),
      });

      setSetup((previous) => ({
        ...previous,
        inspection,
        name: previous.name || inspection.nameSuggestion || inspection.contractName || '',
        description: previous.description || inspection.description || '',
        activation: null,
      }));

      appendClientEvent(
        'system',
        `Verified ABI loaded: ${inspection.functionSignatures.length} functions, gameplay surface ${inspection.supportedActions.map(humanizeAction).join(' / ')}`
      );
    } catch (error) {
      setSetupError(error.message || 'Failed to inspect contract');
      appendClientEvent('system', `Inspection failed: ${error.message || 'unknown error'}`);
    } finally {
      setInspecting(false);
    }
  };

  const handleActivateAgent = async (event) => {
    event.preventDefault();

    if (!setup.inspection) {
      setSetupError('Inspect the contract before arming the agent.');
      return;
    }

    const dailyLimitWei = parseDailyLimitWei(setup.dailyLimitEth);
    if (!dailyLimitWei) {
      setSetupError('Daily ETH ceiling must be a valid ETH amount.');
      return;
    }

    const freePressLimit = toInteger(setup.dailyFreePressLimit, 0, 0);
    const paidPressLimit = toInteger(setup.dailyPaidPressLimit, 0, 0);
    const cadence = toInteger(setup.minMinutesBetweenActions, 60, 1);
    const policyText = buildPolicyText(setup);

    setSubmitting(true);
    setSetupError('');
    appendClientEvent('operator', `Arming mission for ${truncateAddress(setup.contractAddress)} with ${policyText}`);

    try {
      const payload = await fetchJson(GAMES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractAddress: setup.contractAddress,
          name: setup.name || setup.inspection.nameSuggestion,
          description: setup.description || setup.inspection.description,
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
        `Mission stored. Activation ${payload.activation?.status || 'queued'}${payload.activation?.reason ? ` (${payload.activation.reason})` : ''}.`
      );

      await loadSnapshot();
      window.setTimeout(() => {
        void loadSnapshot();
      }, 5000);
    } catch (error) {
      setSetupError(error.message || 'Failed to arm the agent');
      appendClientEvent('system', `Activation failed: ${error.message || 'unknown error'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const focusAgentAddress = getFocusAgentAddress(data.state);
  const focusGame = getFocusGame(data.state, focusAgentAddress);
  const focusDecision = getFocusDecision(data.state, focusAgentAddress, focusGame?.id);
  const focusTransaction = getFocusTransaction(data.state, focusAgentAddress, focusGame?.id);
  const spendMap = buildSpendMap(data.state);
  const focusSpend = focusGame && focusAgentAddress ? spendMap.get(buildSpendKey(focusGame.id, focusAgentAddress)) : null;
  const focusRate = focusGame ? data.gameRates[focusGame.id] : null;
  const currentDailyLimitWei = parseDailyLimitWei(setup.dailyLimitEth);
  const agentBriefing = buildAgentBriefing(setup, focusAgentAddress, focusGame);
  const terminalLines = buildTerminalLines(clientEvents, data.state, focusAgentAddress);
  const policyPreview = buildPolicyText(setup);

  return (
    <div className="app-shell">
      <div className="backdrop-grid" />
      <div className="backdrop-glow backdrop-glow-a" />
      <div className="backdrop-glow backdrop-glow-b" />
      <div className="scanlines" />

      <main className="console-shell">
        <header className="command-header">
          <div className="command-copy">
            <p className="kicker">Scoped autonomy on Base</p>
            <h1>Synthesis Field Terminal</h1>
            <p className="lede">Read a verified contract, expose every callable surface, bind the agent to hard ETH and cadence limits, then watch the runtime move live onchain.</p>
          </div>

          <div className="status-strip">
            <div className="status-cell"><span>Visible field unit</span><strong>{focusAgentAddress ? truncateAddress(focusAgentAddress) : 'Awaiting first pulse'}</strong></div>
            <div className="status-cell"><span>Active missions</span><strong>{data.loading ? '...' : data.state.games.length}</strong></div>
            <div className="status-cell"><span>Refresh cadence</span><strong>{data.lastUpdated ? `${formatClock(data.lastUpdated)} local` : 'Booting'}</strong></div>
          </div>
        </header>

        {data.error ? <section className="signal-banner signal-error"><strong>Feed warning</strong><span>{data.error}</span></section> : null}
        {setupError ? <section className="signal-banner signal-error"><strong>Setup warning</strong><span>{setupError}</span></section> : null}

        <section className="mission-grid">
          <form className="panel-frame setup-panel" onSubmit={handleActivateAgent}>
            <div className="panel-head"><div><p className="section-label">Mission intake</p><h2>Contract address -&gt; ABI -&gt; constraints -&gt; launch</h2></div><span className="panel-chip">Auto-launch on save</span></div>
            <div className="intake-row">
              <input name="contractAddress" value={setup.contractAddress} onChange={handleSetupFieldChange} placeholder="Paste verified Base contract address" required />
              <button className="action-button action-button-primary" disabled={inspecting || !setup.contractAddress} onClick={handleInspectContract} type="button">{inspecting ? 'Reading ABI...' : 'Inspect Contract'}</button>
            </div>

            <div className="agent-transmission">
              <div className="transmission-head"><span className="transmission-dot" />Agent transmission</div>
              <p>{agentBriefing}</p>
              {setup.inspection?.setupSummary ? <span className="transmission-summary">{setup.inspection.setupSummary}</span> : null}
            </div>

            <div className="control-grid">
              <label className="control-field"><span>Mission name</span><input name="name" value={setup.name} onChange={handleSetupFieldChange} placeholder="Beat Powell" /></label>
              <label className="control-field"><span>Daily ETH ceiling</span><input name="dailyLimitEth" value={setup.dailyLimitEth} onChange={handleSetupFieldChange} placeholder="0.00001" required /></label>
              <label className="control-field"><span>Free presses / day</span><input name="dailyFreePressLimit" value={setup.dailyFreePressLimit} onChange={handleSetupFieldChange} placeholder="10" required /></label>
              <label className="control-field"><span>Paid hits / day</span><input name="dailyPaidPressLimit" value={setup.dailyPaidPressLimit} onChange={handleSetupFieldChange} placeholder="1" required /></label>
              <label className="control-field"><span>Minutes between actions</span><input name="minMinutesBetweenActions" value={setup.minMinutesBetweenActions} onChange={handleSetupFieldChange} placeholder="60" required /></label>
              <label className="control-field control-field-wide"><span>Game description</span><textarea name="description" value={setup.description} onChange={handleSetupFieldChange} placeholder="Short operator-facing description of how this game works." /></label>
              <label className="control-field control-field-wide"><span>Operator directive</span><textarea name="operatorDirective" value={setup.operatorDirective} onChange={handleSetupFieldChange} placeholder="Optional nuance for the brain: stay conservative with paid hits until rate is elevated." /></label>
            </div>

            <div className="constraint-strip">
              <div className="constraint-chip"><span>ETH cap</span><strong>{setup.dailyLimitEth || '--'} ETH</strong></div>
              <div className="constraint-chip"><span>Free actions</span><strong>{toInteger(setup.dailyFreePressLimit, 0, 0)}</strong></div>
              <div className="constraint-chip"><span>Paid actions</span><strong>{toInteger(setup.dailyPaidPressLimit, 0, 0)}</strong></div>
              <div className="constraint-chip"><span>Cadence</span><strong>{toInteger(setup.minMinutesBetweenActions, 60, 1)} min</strong></div>
            </div>

            <div className="policy-preview"><span className="section-label">Enforced policy preview</span><p>{policyPreview}</p><span className="policy-meta">Daily ceiling in wei: {currentDailyLimitWei || 'Invalid ETH amount'}</span></div>
            <div className="control-actions"><button className="action-button action-button-primary" disabled={submitting || !setup.inspection} type="submit">{submitting ? 'Arming...' : 'Arm Agent'}</button><div className="activation-state"><span>Status</span><strong>{setup.activation?.status || 'idle'}</strong><small>{setup.activation?.queuedAt ? formatTimestamp(setup.activation.queuedAt) : 'No launch queued yet'}</small></div></div>
          </form>

          <aside className="panel-frame abi-panel">
            <div className="panel-head"><div><p className="section-label">ABI surface</p><h2>{setup.inspection?.contractName || 'Awaiting verified contract'}</h2></div><span className="panel-chip">{setup.inspection ? `${setup.inspection.functionSignatures.length} functions` : 'No ABI'}</span></div>
            <div className="abi-meta">
              <div className="abi-meta-row"><span>Source status</span><strong>{setup.inspection?.sourceVerified ? 'verified' : 'pending'}</strong></div>
              <div className="abi-meta-row"><span>Gameplay surface</span><strong>{setup.inspection?.supportedActions?.length ? setup.inspection.supportedActions.map(humanizeAction).join(' / ') : 'none'}</strong></div>
              <div className="abi-meta-row"><span>Address</span><strong>{setup.inspection ? truncateAddress(setup.inspection.contractAddress) : 'n/a'}</strong></div>
            </div>
            {setup.inspection?.operatorOptions?.length ? <div className="operator-options">{setup.inspection.operatorOptions.map((option) => <span className="operator-pill" key={option}>{option}</span>)}</div> : null}
            <div className="signature-stack">{setup.inspection?.functionSignatures?.length ? setup.inspection.functionSignatures.map((signature) => <code key={signature}>{signature}</code>) : <div className="empty-state"><strong>ABI feed empty</strong><span>Inspect a verified contract to expose every function the agent can see.</span></div>}</div>
          </aside>
        </section>

        <section className="ops-grid">
          <article className="panel-frame focus-panel">
            <div className="panel-head"><div><p className="section-label">Visible field unit</p><h2>{focusAgentAddress ? truncateAddress(focusAgentAddress) : 'No active unit yet'}</h2></div><span className="panel-chip">Latest active embodiment</span></div>
            <div className="focus-stats">
              <div className="focus-row"><span>Live target</span><strong>{focusGame?.name || setup.name || 'No active mission'}</strong></div>
              <div className="focus-row"><span>Current rate</span><strong>{formatRate(focusRate?.value)}</strong></div>
              <div className="focus-row"><span>Last brain action</span><strong className={actionToneClass(focusDecision?.action)}>{focusDecision ? humanizeAction(focusDecision.action) : 'No decision yet'}</strong></div>
              <div className="focus-row"><span>Decision confidence</span><strong>{focusDecision ? formatConfidence(focusDecision.confidence) : '--'}</strong></div>
              <div className="focus-row"><span>Spent today</span><strong>{focusSpend ? `${formatEthCompact(focusSpend.total_spent_wei)} / ${formatEthCompact(focusSpend.daily_limit_wei)}` : focusGame ? `0 ETH / ${formatEthCompact(focusGame.daily_limit_wei)}` : '--'}</strong></div>
              <div className="focus-row"><span>Last chain proof</span><strong>{focusTransaction ? truncateHash(focusTransaction.tx_hash) : 'Waiting for first tx'}</strong></div>
            </div>
            <div className="focus-callout"><span>Reasoning trace</span><p>{focusDecision?.reason || 'No stored reasoning yet. Arm a contract and wait for the first execution cycle.'}</p></div>
          </article>

          <article className="panel-frame mission-panel">
            <div className="panel-head"><div><p className="section-label">Mission roster</p><h2>Chain-bounded operator envelope</h2></div><span className="panel-chip">{data.state.games.length} active</span></div>
            <div className="mission-list">
              {data.state.games.length === 0 ? <div className="empty-state"><strong>No active missions</strong><span>The first saved contract becomes the live demo target.</span></div> : data.state.games.map((game) => (
                <article className="mission-row" key={game.id}>
                  <div className="mission-row-top"><strong>{game.name}</strong><span>{formatRate(data.gameRates[game.id]?.value)}</span></div>
                  <p>{game.description}</p>
                  <div className="mission-tags">
                    <span>{truncateAddress(game.contract_address)}</span>
                    <span>{formatEthCompact(game.daily_limit_wei)}</span>
                    <span>{game.daily_free_press_limit} free/day</span>
                    <span>{game.daily_paid_press_limit} paid/day</span>
                    <span>{game.min_minutes_between_actions} min cadence</span>
                  </div>
                </article>
              ))}
            </div>
          </article>
        </section>

        <section className="panel-frame terminal-panel">
          <div className="panel-head"><div><p className="section-label">Live command trace</p><h2>Operator, brain, and chain output</h2></div><span className="panel-chip">Focused on one visible field unit</span></div>
          <div className="terminal-window">
            {terminalLines.length === 0 ? <div className="empty-state"><strong>Terminal empty</strong><span>Inspect a contract and arm a mission to start the feed.</span></div> : terminalLines.map((line) => (
              <div className="terminal-line" key={line.id}>
                <span className="terminal-time">{formatClock(line.timestamp)}</span>
                <span className={`terminal-channel terminal-channel-${line.channel}`}>{line.channel}</span>
                {line.href ? <a className="terminal-message" href={line.href} rel="noreferrer" target="_blank">{line.message}</a> : <span className="terminal-message">{line.message}</span>}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
