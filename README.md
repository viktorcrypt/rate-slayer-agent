# RateSlayer Gaming Agent

RateSlayer is an onchain gaming agent for Base where the human stays in control.

The core idea is simple:

- a user pastes a verified game contract address
- the agent reads the ABI and surfaces the game functions it can see
- the human decides what actions the agent is allowed to use
- the human sets hard spending and cadence limits
- the agent starts operating within those limits
- every decision and transaction is visible and auditable

## Hackathon Angle

This project is built around the idea of **agents that pay**, but with **human-defined boundaries**.

Instead of giving an agent an open wallet and hoping it behaves, the operator defines:

- maximum ETH the agent can spend per day
- how many times it can act per day
- how often it is allowed to act
- which onchain game actions it is allowed to use

The result is an agent that can play autonomously, while the human still controls risk.

## Demo Flow

1. Open the dashboard
2. Paste a verified Base game contract address
3. The agent inspects the ABI and shows the contract functions
4. Select the actions you want the agent to use
5. Set daily ETH spend and action frequency limits
6. Launch the agent
7. Watch the live activity feed and transaction history

For the main demo, the reference game is Beat Powell V2 on Base.

## What The Operator Controls

The dashboard is designed around operator control, not blind autonomy.

The human can define:

- `ETH per day`
- `free actions per day`
- `paid actions per day`
- `minimum minutes between actions`

These limits are enforced by the runtime, not just suggested to the model.

## What The Agent Does

Once configured, the agent:

- reads verified ABI data from the explorer
- reasons about the current game state
- decides whether to act or skip
- respects the configured spend and timing limits
- records decisions and onchain activity

The dashboard shows:

- detected game functions
- selected action set
- current game state
- last decision and reason
- recent activity feed
- recent transaction linkouts to BaseScan

## Architecture

- `agent/` runs the autonomous runtime
- `dashboard/` is the React terminal-style operator UI
- PostgreSQL stores games, decisions, transactions, and daily state
- Express exposes the API used by the dashboard
- Groq is used for contract summarization and runtime decisioning
- policy enforcement is done deterministically in code

## Monorepo Structure

```text
rate-slayer-agent/
|- agent/
|  |- src/
|  |  |- api.js
|  |  |- brain.js
|  |  |- db.js
|  |  |- executor.js
|  |  |- guard.js
|  |  \- setup.js
|  |- index.js
|  |- package.json
|  \- .env.example
|- dashboard/
|  |- public/
|  |- src/
|  |  |- App.jsx
|  |  |- dashboard-lib.js
|  |  |- main.jsx
|  |  \- styles.css
|  |- index.html
|  |- package.json
|  \- vite.config.js
|- package.json
\- README.md
```

## Install

```bash
npm install
```

## Run

Run the agent:

```bash
npm run agent
```

Run the dashboard:

```bash
npm run dashboard
```

Run both:

```bash
npm run dev
```

From `agent/` you can also run:

```bash
npm run once
npm run status
```

## Important Environment Variables

- `DATABASE_URL`
- `AGENT_PRIVATE_KEYS`
- `AGENT_NAMES`
- `BASE_RPC_URL_READ`
- `BASE_RPC_URL_WRITE`
- `ETHERSCAN_API_KEY`
- `ETHERSCAN_API_URL`
- `BASE_CHAIN_ID`
- `GROQ_API_KEY`
- `GROQ_MAX_DAILY_ETH_SPEND`
- `AGENT_POLL_CRON`
- `AGENT_API_URL`

Useful for demos:

- `DEMO_AGENT_ADDRESS`
  Limits runtime activity to one visible demo wallet

Root `.env` remains the default source for both workspace packages.

## Short Pitch

Paste a game contract.

Let the agent inspect the ABI.

Tell it how much it may spend and how often it may act.

Then let it play onchain, with the human still in control.
