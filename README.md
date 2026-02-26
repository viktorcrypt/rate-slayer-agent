# 🤖 Rate Slayer Agent

Autonomous onchain gaming agent running on Base.

Built for **OpenClaw Builder Quest (Base Agent Track)** with no human in the loop.

## 🧠 Core Idea
This project is bigger than one game.

Right now, the live demo behavior is shown through **BeatPowell / Rate Slayer**.  
The core architecture is designed so the same agent system can later plug into **other onchain games** and run different strategies there too.

## 🎯 What It Does
- Automatically hits Powell every hour to lower the Fed rate.
- Posts updates to Farcaster about successful actions.
- Runs 24/7 with cron scheduling.
- Supports one or many wallet agents in one process.
- Uses Base onchain transactions and builder attribution.

## 🏆 OpenClaw Builder Quest Submission
This agent qualifies for the contest because:
- Autonomous: no human in the loop, runs on cron.
- Onchain transactions: calls smart contract on Base.
- Social presence: posts successful updates to Farcaster.
- Onchain primitives: uses Base smart contracts and wallet signing.
- Novel use case: gaming + DeFi automation.

Project references:
- Farcaster Profile: https://farcaster.xyz/vikigraf
- Contract: `0xeC6AF3c5934F383972bb9980A51EC976099270b8`
- App: `https://rate-slayer.vercel.app`

## 📡 Monitoring The Agent
Track activity through:
- Farcaster feed for successful bot posts.
- Basescan contract page for onchain transactions.
- Service logs for cooldown, retries, and execution flow.

## 🛠️ Technical Details
- Blockchain: Base (Chain ID 8453).
- Contract: Rate Slayer game contract.
- Framework: Node.js + viem.
- Scheduler: node-cron.
- Social: Farcaster via Neynar API.

## 🚀 Run
```bash
npm install
npm start
```

## 🧪 Test Commands
```bash
npm run once
node index.js --status
```

## 🆘 Support
If something fails:
- Check logs first.
- Verify runtime environment variables are set.
- Ensure each active wallet has ETH on Base.
- Test once before long-running mode.

Built for OpenClaw Builder Quest on Base.
