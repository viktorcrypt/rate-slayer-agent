# 🤖 Rate Slayer Agent

Autonomous agent that plays [Rate Slayer](https://rate-slayer.vercel.app) game on Base blockchain.

**Built for OpenClaw Builder Quest** - No human in the loop autonomous agent!

## 🎯 What it does

- ✅ Automatically hits Powell every hour to lower the Fed rate
- ✅ Posts updates to Farcaster about its actions
- ✅ Runs 24/7 with cron scheduling
- ✅ Fully autonomous - no human intervention needed
- ✅ Built on Base with onchain transactions

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

Create a `.env` file:

```bash
cp .env.example .env
```

Fill in the following:

```env
# Single-agent mode
PRIVATE_KEY=your_private_key_here

# Multi-agent mode (overrides PRIVATE_KEY when set)
# AGENT_PRIVATE_KEYS=pk_agent_1,pk_agent_2,pk_agent_3
# AGENT_NAMES=Slayer-1,Slayer-2,Slayer-3
# AGENT_RUN_STAGGER_MS=3000
# AGENT_RANDOM_SKIP_CHANCE=0.35
# AGENT_ACTION_DELAY_MIN_MS=15000
# AGENT_ACTION_DELAY_MAX_MS=180000

# Get from https://neynar.com (free)
NEYNAR_API_KEY=your_neynar_api_key
FARCASTER_SIGNER_UUID=your_signer_uuid
FARCASTER_POSTS_ENABLED=false

# Already configured
CONTRACT_ADDRESS=0xeC6AF3c5934F383972bb9980A51EC976099270b8
BASE_RPC_URL=https://mainnet.base.org
APP_URL=https://rate-slayer.vercel.app

# Optional: post cadence (default = every successful run)
POST_EVERY_N_HOURS=1

# Optional: Base Builder attribution (recommended for Base builder portal tracking)
# Use one of:
# 1) BUILDER_CODE=your_builder_code
# 2) BUILDER_CODES=code_one,code_two
# 3) BUILDER_DATA_SUFFIX=0x...   (precomputed ERC-8021 suffix)
```

### 3. Fund the agent wallet

The agent needs a small amount of ETH on Base to pay for gas:

1. Generate a new wallet or use existing one
2. Send ~0.01 ETH to the agent's address (shown when you run the bot)
3. The agent will use this to pay for `press()` transactions
4. If you use multi-agent mode, fund each wallet address

### 4. Run the agent

```bash
# Run once (test mode)
npm run once

# Check status without pressing
node index.js --status

# Start the agent (runs every hour)
npm start
```

### 5. Multi-agent test mode (optional)

Use multiple wallets inside one process:

```env
AGENT_PRIVATE_KEYS=pk_agent_1,pk_agent_2,pk_agent_3
AGENT_NAMES=Slayer-1,Slayer-2,Slayer-3
AGENT_RUN_STAGGER_MS=3000
AGENT_RANDOM_SKIP_CHANCE=0.35
AGENT_ACTION_DELAY_MIN_MS=15000
AGENT_ACTION_DELAY_MAX_MS=180000
```

Notes:
- `AGENT_PRIVATE_KEYS` takes precedence over `PRIVATE_KEY`
- use unique private keys (duplicate keys behave like one wallet with different labels)
- each wallet has its own cooldown in the contract
- each cycle has random behavior: skip chance + random delay before press

## 🔧 How to get Farcaster credentials

### Option 1: Neynar (Recommended - Easy)

1. Go to [neynar.com](https://neynar.com)
2. Sign up for free account
3. Go to Dashboard → API Keys
4. Copy your API key
5. Create a signer:
   - Go to "Signers" section
   - Click "Create Signer"
   - Approve with your Farcaster account (Warpcast)
   - Copy the `signer_uuid`

### Option 2: Manual Farcaster setup

If you want more control, you can use Farcaster's native APIs, but Neynar is much easier for getting started.

## 📊 Features

### Automatic Actions
- Checks cooldown before attempting to press
- Reads current Fed rate from contract
- Executes press transaction
- Adds random skip/delay so agents do not act at exact same pattern
- Posts result to Farcaster
- Supports one or many agent wallets in one process

### Smart Posting
- Randomized message templates for variety
- Includes stats (rate change, total presses)
- Links to the app
- Error handling with status updates
- Posting cadence configurable via `POST_EVERY_N_HOURS`
- Enable/disable posting via `FARCASTER_POSTS_ENABLED`

### Monitoring
- Logs all actions to console
- Tracks transaction hashes
- Reports cooldown status
- Health checks available
- Runs multi-agent wallets sequentially with configurable stagger

## 🎮 Example Posts

The agent will post messages like:

```
🤖 AUTO-HIT #42! 👊

Fed Rate: 3.75% → 3.74%

The bot is fighting inflation onchain! 📉

https://rate-slayer.vercel.app
```

```
⚡ Bot just slapped Powell!

Rate: 3.73%
Total hits today: 156

Autonomous agent keeping rates low 💪

https://rate-slayer.vercel.app
```

## 🚀 Deployment Options

### Railway (Recommended)

1. Push code to GitHub
2. Connect to Railway
3. Add environment variables
4. Deploy!

```bash
# Railway will auto-detect Node.js and run npm start
```

### Render

1. Create new Web Service
2. Connect GitHub repo
3. Build: `npm install`
4. Start: `npm start`
5. Add environment variables

### VPS (DigitalOcean, AWS, etc)

```bash
# Clone repo
git clone <your-repo>
cd rate-slayer-agent

# Install dependencies
npm install

# Setup PM2 for process management
npm install -g pm2

# Start with PM2
pm2 start index.js --name rate-slayer-agent
pm2 save
pm2 startup
```

## 📁 Project Structure

```
rate-slayer-agent/
├── index.js           # Main agent logic
├── package.json       # Dependencies
├── .env.example       # Environment template
├── .gitignore         # Git ignore rules
└── README.md          # This file
```

## 🔍 Troubleshooting

### "Cooldown active"
- This is normal! Agent will wait and try next hour
- Each wallet can only press once per hour

### "Insufficient funds"
- Add more ETH to agent's wallet on Base
- You need ~0.001 ETH per transaction

### "Farcaster post failed"
- Check API key is correct
- Verify signer UUID is set up
- Make sure signer is approved in Warpcast

### Agent not running every hour
- Check cron is working: `cron.schedule('0 * * * *')`
- Verify server time is correct
- Check process is still running

## 📝 OpenClaw Builder Quest Submission

This agent qualifies for the contest because:

✅ **Autonomous**: No human in the loop - runs on cron  
✅ **Onchain transactions**: Calls smart contract on Base every hour  
✅ **Social presence**: Posts to Farcaster automatically  
✅ **Onchain primitives**: Uses Base smart contracts, wallet signing  
✅ **Novel use case**: Gaming meets DeFi automation  

**Farcaster Profile**: [Your profile link here]  
**Contract**: `0xeC6AF3c5934F383972bb9980A51EC976099270b8`  
**App**: https://rate-slayer.vercel.app

## 🎯 Monitoring the Agent

Watch the agent's activity:
- **Farcaster**: Check your feed for bot posts
- **Basescan**: [Contract on Basescan](https://basescan.org/address/0xeC6AF3c5934F383972bb9980A51EC976099270b8)
- **Logs**: Check server logs for activity

## 🛠️ Technical Details

- **Blockchain**: Base (Chain ID: 8453)
- **Contract**: Rate Slayer game contract
- **Framework**: Node.js + viem
- **Scheduler**: node-cron
- **Social**: Farcaster via Neynar API

## 📞 Support

Questions? Issues?
- Check the logs first
- Verify all environment variables are set
- Make sure wallet has ETH on Base
- Test with `npm run once` before running scheduler

---

**The printer goes BRRR** 🖨️💸

Built for OpenClaw Builder Quest 🏆
