# Rate Slayer Workspace

This repo is a workspace monorepo with:

- `agent/`: the autonomous Base agent runtime
- `dashboard/`: the React dashboard and setup wizard

## Current Flow

The system now supports a hackathon-friendly flow for BeatPowell-style games:

1. Open the dashboard
2. Paste a Base contract address
3. Inspect the verified ABI from the explorer
4. See detected supported actions such as `press()` and `pressWithBet()`
5. Enter a human policy like:
   - `10 press per day`
   - `1 paid hit per day`
   - `do not spend more than 0.00001 ETH per day`
   - `wait at least 60 minutes between actions`
6. Save the game
7. Let the agent enforce those rules and show results in the dashboard

## Architecture

- PostgreSQL stores active games, parsed policy, decisions, and transactions
- Express exposes `/state`, `/games`, `/contracts/inspect`, and `/policies/parse`
- The agent loop loads active games from PostgreSQL
- The setup layer inspects verified ABI data from the explorer and derives supported actions
- Groq is used for:
  - runtime action decisions
  - setup-time contract summary
  - setup-time policy parsing
- Policy enforcement is deterministic in code:
  - free press per day limit
  - paid hit per day limit
  - daily ETH spend limit
  - minimum minutes between actions

## Structure

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

## Agent Commands

From `agent/`:

```bash
npm run once
npm run status
```

## Environment

Important env vars:

- `DATABASE_URL`
- `AGENT_PRIVATE_KEYS`
- `AGENT_NAMES`
- `BASE_RPC_URL_READ`
- `BASE_RPC_URL_WRITE`
- `ETHERSCAN_API_KEY`
- `ETHERSCAN_API_URL` default `https://api.etherscan.io/v2/api`
- `BASE_CHAIN_ID` default `8453`
- `GROQ_API_KEY`
- `AGENT_API_URL` for dashboard proxying in local dev
- `AGENT_POLL_CRON` default `*/5 * * * *`

Root `.env` remains the default source for both workspace packages.
