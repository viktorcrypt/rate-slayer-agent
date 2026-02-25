import { concatHex, createPublicClient, createWalletClient, http, numberToHex, parseAbi, stringToHex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import cron from 'node-cron';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();


const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS || '0xeC6AF3c5934F383972bb9980A51EC976099270b8';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const NEYNAR_API_KEY = process.env.NEYNAR_API_KEY;
const FARCASTER_SIGNER_UUID = process.env.FARCASTER_SIGNER_UUID;
const APP_URL = process.env.APP_URL || 'https://rate-slayer.vercel.app';
const BASE_RPC_URL_READ = process.env.BASE_RPC_URL_READ || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const BASE_RPC_URL_WRITE = process.env.BASE_RPC_URL_WRITE || process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const RPC_MAX_RETRIES = Number(process.env.RPC_MAX_RETRIES || 5);
const RPC_BASE_DELAY_MS = Number(process.env.RPC_BASE_DELAY_MS || 500);
const RPC_MAX_DELAY_MS = Number(process.env.RPC_MAX_DELAY_MS || 8000);
const RPC_JITTER_MS = Number(process.env.RPC_JITTER_MS || 200);
const POST_EVERY_N_HOURS = Math.max(1, Number(process.env.POST_EVERY_N_HOURS || 1));
const BUILDER_CODE = process.env.BUILDER_CODE?.trim();
const BUILDER_CODES = (process.env.BUILDER_CODES || '')
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
const BUILDER_DATA_SUFFIX = process.env.BUILDER_DATA_SUFFIX?.trim();
const ERC8021_DATA_SUFFIX = '0x80218021802180218021802180218021';

// Contract ABI
const CONTRACT_ABI = parseAbi([
  'function rateBps() view returns (uint256)',
  'function totalPresses() view returns (uint256)',
  'function lastUpdateTime() view returns (uint256)',
  'function timeUntilNextPress(address user) view returns (uint256)',
  'function getCurrentRate() view returns (uint256)',
  'function press()',
  'function RATE_INCREASE_PER_HOUR() view returns (uint256)',
  'function DECREASE_PER_PRESS() view returns (uint256)',
  'function MAX_RATE() view returns (uint256)',
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
    numberToHex(0, { size: 1 }), // schema id 0
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

const TX_DATA_SUFFIX = resolveTxDataSuffix();


const account = privateKeyToAccount(`0x${PRIVATE_KEY.replace('0x', '')}`);

const publicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL_READ),
});

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(BASE_RPC_URL_WRITE),
  ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function withRpcRetry(fn, label) {
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



async function getCurrentRate() {
  const rate = await withRpcRetry(
    () => publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'getCurrentRate',
    }),
    'getCurrentRate'
  );
  return Number(rate) / 100; 
}

async function getTotalPresses() {
  const presses = await withRpcRetry(
    () => publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'totalPresses',
    }),
    'getTotalPresses'
  );
  return Number(presses);
}

async function getTimeUntilNextPress() {
  const time = await withRpcRetry(
    () => publicClient.readContract({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'timeUntilNextPress',
      args: [account.address],
    }),
    'getTimeUntilNextPress'
  );
  return Number(time);
}

async function getPrePressSnapshot() {
  const [rate, presses, cooldown] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'totalPresses',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'timeUntilNextPress',
          args: [account.address],
        },
      ],
    }),
    'prePressSnapshot'
  );

  return {
    rate: Number(rate) / 100,
    presses: Number(presses),
    cooldown: Number(cooldown),
  };
}

async function getPostPressSnapshot() {
  const [rate, presses] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      contracts: [
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'getCurrentRate',
        },
        {
          address: CONTRACT_ADDRESS,
          abi: CONTRACT_ABI,
          functionName: 'totalPresses',
        },
      ],
    }),
    'postPressSnapshot'
  );

  return {
    rate: Number(rate) / 100,
    presses: Number(presses),
  };
}

async function pressPowell() {
  console.log('🎯 Attempting to press Powell...');
  
  const { request } = await withRpcRetry(
    () => publicClient.simulateContract({
      account,
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      functionName: 'press',
      ...(TX_DATA_SUFFIX ? { dataSuffix: TX_DATA_SUFFIX } : {}),
    }),
    'simulatePress'
  );

  const hash = await walletClient.writeContract(request);
  console.log('📝 Transaction sent:', hash);

  const receipt = await withRpcRetry(
    () => publicClient.waitForTransactionReceipt({ hash }),
    'waitForReceipt'
  );
  console.log('✅ Transaction confirmed!');
  
  return receipt;
}



async function postToFarcaster(text) {
  if (!NEYNAR_API_KEY || !FARCASTER_SIGNER_UUID) {
    console.log('⚠️  Farcaster not configured, skipping post');
    console.log('📝 Would have posted:', text);
    return;
  }

  try {
    const response = await axios.post(
      'https://api.neynar.com/v2/farcaster/cast',
      {
        signer_uuid: FARCASTER_SIGNER_UUID,
        text: text,
      },
      {
        headers: {
          'api_key': NEYNAR_API_KEY,
          'content-type': 'application/json',
        },
      }
    );

    console.log('✅ Posted to Farcaster:', response.data.cast.hash);
    return response.data;
  } catch (error) {
    console.error('❌ Failed to post to Farcaster:', error.response?.data || error.message);
  }
}


async function runAgent() {
  try {
    console.log('\n' + '='.repeat(50));
    console.log('🤖 Rate Slayer Agent Running...');
    console.log('⏰', new Date().toLocaleString());
    console.log('💼 Agent Address:', account.address);
    console.log('='.repeat(50) + '\n');

    
    const preSnapshot = await getPrePressSnapshot();
    const cooldown = preSnapshot.cooldown;
    if (cooldown > 0) {
      const minutes = Math.floor(cooldown / 60);
      const seconds = cooldown % 60;
      console.log(`⏳ Cooldown active: ${minutes}m ${seconds}s remaining`);
      console.log('⏭️  Skipping this run...\n');
      return;
    }

    
    const rateBefore = preSnapshot.rate;
    const pressesBefore = preSnapshot.presses;
    
    console.log(`📊 Current Rate: ${rateBefore.toFixed(2)}%`);
    console.log(`📈 Total Presses: ${pressesBefore}`);

    
    await pressPowell();

    
    await new Promise(resolve => setTimeout(resolve, 5000));

    
    const postSnapshot = await getPostPressSnapshot();
    const rateAfter = postSnapshot.rate;
    const pressesAfter = postSnapshot.presses;

    console.log(`\n📉 New Rate: ${rateAfter.toFixed(2)}%`);
    console.log(`🎯 Total Presses: ${pressesAfter}`);

    
    const messages = [
      `🤖 AUTO-HIT #${pressesAfter}! 👊\n\nFed Rate: ${rateBefore.toFixed(2)}% → ${rateAfter.toFixed(2)}%\n\nAutonomous agent fighting inflation onchain! 📉\n\n${APP_URL}`,
      
      `⚡ Just slapped Powell!\n\nRate: ${rateAfter.toFixed(2)}%\nTotal hits: ${pressesAfter}\n\nKeeping rates low 24/7 💪\n\n${APP_URL}`,
      
      `👊 HIT #${pressesAfter} COMPLETE!\n\nFed Rate: ${rateBefore.toFixed(2)}% → ${rateAfter.toFixed(2)}%\n\nNo human in the loop! Pure onchain action 🤖\n\n${APP_URL}`,
      
      `🎯 Another one!\n\nPowell took another hit\nRate: ${rateAfter.toFixed(2)}%\nTotal: ${pressesAfter} hits\n\nThe printer goes BRRR 🖨️💸\n\n${APP_URL}`,
      
      `📉 Rate update!\n\n${rateBefore.toFixed(2)}% → ${rateAfter.toFixed(2)}%\n\nBot status: Active ✅\nNext hit: 1 hour\n\n${APP_URL}`,
      
      `💪 Still fighting!\n\nCurrent Fed Rate: ${rateAfter.toFixed(2)}%\nHits landed: ${pressesAfter}\n\nAutonomous. Relentless. Onchain.\n\n${APP_URL}`,
      
      `🚀 Transaction confirmed!\n\nPress #${pressesAfter} successful\nRate impact: -0.01%\nNew rate: ${rateAfter.toFixed(2)}%\n\n${APP_URL}`,
      
      `⚡ Rate Slayer Bot reporting in!\n\nLatest hit: Success ✅\nFed Rate: ${rateAfter.toFixed(2)}%\nUptime: 100%\n\n${APP_URL}`,
      
      `🎮 Game on!\n\nJust pressed Powell onchain\nRate dropped to ${rateAfter.toFixed(2)}%\nCommunity hits: ${pressesAfter}\n\n${APP_URL}`,
      
      `💥 BOOM! Hit landed!\n\n${rateBefore.toFixed(2)}% → ${rateAfter.toFixed(2)}%\n\nAgent working overtime to keep inflation low 📊\n\n${APP_URL}`,
      
      `🤖 Beep boop!\n\nExecuted press() function\nGas paid ✅\nRate decreased ✅\nPowell status: 😤\n\n${APP_URL}`,
      
      `📊 Hourly update:\n\nFed Rate: ${rateAfter.toFixed(2)}%\nTotal presses: ${pressesAfter}\nNext action: Scheduled\n\nAutonomous agent on Base 🔵\n\n${APP_URL}`,
      
      `⚡ Smart contract call complete!\n\nFunction: press()\nRate change: -0.01%\nCurrent: ${rateAfter.toFixed(2)}%\n\nNo humans, just code 🤖\n\n${APP_URL}`,
      
      `🎯 Mission accomplished!\n\nHit #${pressesAfter} deployed\nInflation: Decreasing\nPowell: Recovering\n\nWe fight every hour 💪\n\n${APP_URL}`,
      
      `💼 Rate Slayer at work!\n\n${rateBefore.toFixed(2)}% → ${rateAfter.toFixed(2)}%\n\nBuilding on Base\nRunning 24/7\nFully autonomous\n\n${APP_URL}`,
    ];

    
    const hour = new Date().getHours();
    const shouldPost = hour % POST_EVERY_N_HOURS === 0; 
    
    if (shouldPost) {
      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      await postToFarcaster(randomMessage);
    } else {
      const nextPostingHour = Math.ceil((hour + 1) / POST_EVERY_N_HOURS) * POST_EVERY_N_HOURS;
      console.log(`⏭️  Skipping Farcaster post (posting every ${POST_EVERY_N_HOURS} hour(s))`);
      console.log('📝 Next post scheduled for:', `${nextPostingHour % 24}:00`);
    }

    console.log('\n✨ Agent run completed successfully!\n');

  } catch (error) {
    console.error('❌ Agent error:', error);
    
    
    if (String(error?.message || '').includes('cooldown')) {
      console.log('ℹ️  Cooldown error - this is normal, will try next hour');
    } else {
      await postToFarcaster(
        `⚠️ Rate Slayer Bot encountered an issue\n\nStatus: Investigating\nWill retry next hour\n\n${APP_URL}`
      );
    }
  }
}


async function checkStatus() {
  try {
    console.log('\n📊 Rate Slayer Status Check\n');
    
    const snapshot = await getPrePressSnapshot();
    const rate = snapshot.rate;
    const presses = snapshot.presses;
    const cooldown = snapshot.cooldown;
    
    console.log(`Current Rate: ${rate.toFixed(2)}%`);
    console.log(`Total Presses: ${presses}`);
    console.log(`Agent Address: ${account.address}`);
    console.log(`Cooldown: ${cooldown}s`);
    
    if (cooldown === 0) {
      console.log('\n✅ Ready to press!');
    } else {
      const minutes = Math.floor(cooldown / 60);
      console.log(`\n⏳ Next press available in ${minutes} minutes`);
    }
  } catch (error) {
    console.error('❌ Status check error:', error);
  }
}



async function startAgent() {
  console.log('\n🚀 Rate Slayer Agent Started!\n');
  console.log('⏰ Will run every hour on the hour');
  console.log('💼 Agent wallet:', account.address);
  console.log('📍 Contract:', CONTRACT_ADDRESS);
  console.log('📰 Farcaster posting cadence:', `every ${POST_EVERY_N_HOURS} hour(s)`);
  console.log('🏷️  Builder attribution:', TX_DATA_SUFFIX ? 'enabled' : 'disabled');
  if (TX_DATA_SUFFIX) {
    const attributionSource = BUILDER_DATA_SUFFIX ? 'BUILDER_DATA_SUFFIX' : 'BUILDER_CODE(S)';
    console.log('🔧 Attribution source:', attributionSource);
  }
  console.log('\n' + '='.repeat(50) + '\n');

  // Check if running in test mode
  if (process.argv.includes('--once')) {
    console.log('🧪 Running in test mode (one-time execution)');
    await runAgent();
    process.exit(0);
  }

  if (process.argv.includes('--status')) {
    await checkStatus();
    process.exit(0);
  }

  // Run immediately on start
  await runAgent();

  // Schedule to run every hour at the top of the hour
  cron.schedule('0 * * * *', async () => {
    await runAgent();
  });

  console.log('✅ Scheduler active. Agent will run every hour.');
  console.log('⌨️  Press Ctrl+C to stop\n');
}


startAgent().catch(console.error);
