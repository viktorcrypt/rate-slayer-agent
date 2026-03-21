import { parseEther } from 'viem';

const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

function buildRunPrompt(context) {
  const allowedActions = Array.isArray(context.allowedActions) && context.allowedActions.length > 0
    ? context.allowedActions.join(', ')
    : 'skip';
  const policyText = context.policyText || 'No explicit operator policy provided.';

  return [
    `You are an autonomous onchain gaming agent. Game: ${context.gameName}.`,
    `Rules: ${context.gameDescription}.`,
    `Operator policy: ${policyText}.`,
    `Allowed actions right now: ${allowedActions}.`,
    'Only choose an action from the allowed actions list or skip.',
    'Respond JSON only: {action, betAmountWei, reason, confidence}',
  ].join(' ');
}

function buildSetupPrompt() {
  return [
    'You are analyzing a verified Base smart contract for an autonomous game-agent setup wizard.',
    'Infer the operator-facing setup summary from the contract functions.',
    'Respond JSON only: {nameSuggestion, description, operatorOptions, setupSummary, policySuggestion}.',
    'Keep it concise and only mention actions that actually appear in the function signatures.',
  ].join(' ');
}

function buildPolicyPrompt() {
  return [
    'You convert an operator policy text into strict machine-readable limits for an onchain agent.',
    'Respond JSON only: {dailyPressLimit, dailyPaidPressLimit, dailyLimitWei, minMinutesBetweenActions, summary}.',
    'If an action is unsupported, set its limit to 0.',
    'Never invent extra actions.',
  ].join(' ');
}

function fallbackDecision(reason = 'LLM unavailable') {
  return {
    action: 'skip',
    betAmountWei: '0',
    reason,
    confidence: 0,
  };
}

function extractJson(content) {
  if (!content) {
    return null;
  }

  const trimmed = String(content).trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function normalizeConfidence(confidence) {
  const value = Number(confidence ?? 0);
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value > 1 && value <= 100) {
    return Math.max(0, Math.min(1, value / 100));
  }

  return Math.max(0, Math.min(1, value));
}

function clampInteger(value, fallback, min = 0, max = 1000000) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(normalized)));
}

function normalizeDecision(value) {
  if (!value || typeof value !== 'object') {
    return fallbackDecision();
  }

  const action = value.action === 'pressWithBet'
    ? 'pressWithBet'
    : (value.action === 'press' ? 'press' : 'skip');

  return {
    action,
    betAmountWei: String(value.betAmountWei || '0'),
    reason: String(value.reason || 'No reason provided'),
    confidence: normalizeConfidence(value.confidence),
  };
}

function defaultSetupAnalysis(input) {
  const supportedActions = Array.isArray(input.supportedActions) ? input.supportedActions : [];
  const operatorOptions = supportedActions.map((action) => (
    action === 'press'
      ? 'Free press via press()'
      : 'Paid hit via pressWithBet()'
  ));
  const description = supportedActions.includes('pressWithBet')
    ? 'BeatPowell-style contract with a free press and an optional paid hit.'
    : 'BeatPowell-style contract with a free press action.';
  const policySuggestionParts = [];

  if (supportedActions.includes('press')) {
    policySuggestionParts.push('10 press per day');
  }

  if (supportedActions.includes('pressWithBet')) {
    policySuggestionParts.push('1 paid hit per day');
  }

  policySuggestionParts.push('do not spend more than 0.00001 ETH per day');
  policySuggestionParts.push('wait at least 60 minutes between actions');

  return {
    nameSuggestion: String(input.contractName || `Game ${String(input.contractAddress || '').slice(0, 8)}`),
    description,
    operatorOptions,
    setupSummary: `Detected actions: ${supportedActions.join(', ') || 'none'}.`,
    policySuggestion: policySuggestionParts.join(', '),
  };
}

function tryParseEthToWei(value) {
  const stringValue = String(value || '').trim();
  if (!stringValue) {
    return null;
  }

  try {
    return parseEther(stringValue).toString();
  } catch {
    return null;
  }
}

function buildFallbackPolicy(input) {
  const supportedActions = new Set(Array.isArray(input.supportedActions) ? input.supportedActions : []);
  const text = String(input.policyText || '');
  const lower = text.toLowerCase();
  let dailyPressLimit = supportedActions.has('press') ? 10 : 0;
  let dailyPaidPressLimit = supportedActions.has('pressWithBet') ? 1 : 0;
  let dailyLimitWei = String(input.defaultDailyLimitWei || '500000000000000');
  let minMinutesBetweenActions = clampInteger(input.defaultMinMinutesBetweenActions, 60, 1, 1440);

  const paidMatch = lower.match(/(\d+)\s*(?:paid\s*(?:hit|press|strike)s?|presswithbet|bet(?:s)?)/i);
  if (paidMatch) {
    dailyPaidPressLimit = clampInteger(paidMatch[1], dailyPaidPressLimit, 0, 1000000);
  }

  const freePressMatch = lower.match(/(\d+)\s*(?:free\s*)?press(?:es)?/i);
  if (freePressMatch) {
    dailyPressLimit = clampInteger(freePressMatch[1], dailyPressLimit, 0, 1000000);
  }

  const ethMatch = lower.match(/([0-9]*\.?[0-9]+)\s*eth\b/i);
  if (ethMatch) {
    dailyLimitWei = tryParseEthToWei(ethMatch[1]) || dailyLimitWei;
  }

  const weiMatch = lower.match(/(\d+)\s*wei\b/i);
  if (weiMatch) {
    dailyLimitWei = String(weiMatch[1]);
  }

  const cadenceMatch = lower.match(/(\d+)\s*(minute|minutes|min|hour|hours|hr|hrs)\b/i);
  if (cadenceMatch) {
    const amount = clampInteger(cadenceMatch[1], minMinutesBetweenActions, 1, 1000000);
    const unit = cadenceMatch[2].toLowerCase();
    minMinutesBetweenActions = unit.startsWith('h')
      ? Math.min(1440, amount * 60)
      : Math.min(1440, amount);
  }

  if (!supportedActions.has('press')) {
    dailyPressLimit = 0;
  }

  if (!supportedActions.has('pressWithBet')) {
    dailyPaidPressLimit = 0;
  }

  return {
    dailyPressLimit,
    dailyPaidPressLimit,
    dailyLimitWei,
    minMinutesBetweenActions,
    summary: [
      supportedActions.has('press') ? `${dailyPressLimit} press/day` : null,
      supportedActions.has('pressWithBet') ? `${dailyPaidPressLimit} paid hits/day` : null,
      `daily ETH limit ${dailyLimitWei} wei`,
      `minimum cadence ${minMinutesBetweenActions} minutes`,
    ]
      .filter(Boolean)
      .join(', '),
  };
}

function normalizeSetupAnalysis(value, input) {
  const fallback = defaultSetupAnalysis(input);
  if (!value || typeof value !== 'object') {
    return fallback;
  }

  const operatorOptions = Array.isArray(value.operatorOptions)
    ? value.operatorOptions.map((item) => String(item || '').trim()).filter(Boolean)
    : fallback.operatorOptions;

  return {
    nameSuggestion: String(value.nameSuggestion || fallback.nameSuggestion),
    description: String(value.description || fallback.description),
    operatorOptions: operatorOptions.length > 0 ? operatorOptions : fallback.operatorOptions,
    setupSummary: String(value.setupSummary || fallback.setupSummary),
    policySuggestion: String(value.policySuggestion || fallback.policySuggestion),
  };
}

function normalizePolicyResponse(value, input) {
  const fallback = buildFallbackPolicy(input);
  if (!value || typeof value !== 'object') {
    return {
      ...fallback,
      policyText: String(input.policyText || ''),
      supportedActions: Array.isArray(input.supportedActions) ? input.supportedActions : [],
    };
  }

  const supportedActions = Array.isArray(input.supportedActions) ? input.supportedActions : [];
  let dailyLimitWei = String(value.dailyLimitWei || value.dailyEthLimitWei || fallback.dailyLimitWei);

  if ((!dailyLimitWei || dailyLimitWei === '[object Object]') && value.dailyLimitEth !== undefined) {
    dailyLimitWei = tryParseEthToWei(value.dailyLimitEth) || fallback.dailyLimitWei;
  }

  if (!/^\d+$/.test(dailyLimitWei)) {
    dailyLimitWei = fallback.dailyLimitWei;
  }

  let dailyPressLimit = clampInteger(value.dailyPressLimit, fallback.dailyPressLimit, 0, 1000000);
  let dailyPaidPressLimit = clampInteger(value.dailyPaidPressLimit, fallback.dailyPaidPressLimit, 0, 1000000);

  if (!supportedActions.includes('press')) {
    dailyPressLimit = 0;
  }

  if (!supportedActions.includes('pressWithBet')) {
    dailyPaidPressLimit = 0;
  }

  return {
    policyText: String(input.policyText || ''),
    supportedActions,
    dailyPressLimit,
    dailyPaidPressLimit,
    dailyLimitWei,
    minMinutesBetweenActions: clampInteger(
      value.minMinutesBetweenActions,
      fallback.minMinutesBetweenActions,
      1,
      1440
    ),
    summary: String(value.summary || fallback.summary),
  };
}

async function callGroqJson(systemPrompt, payload, normalize, fallbackValue) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return fallbackValue;
  }

  try {
    const response = await fetch(GROQ_API_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: JSON.stringify(payload),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Groq API error ${response.status}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);

    if (!parsed) {
      throw new Error('Groq response was not valid JSON');
    }

    return normalize(parsed);
  } catch {
    return fallbackValue;
  }
}

export async function analyzeContractSetup(context) {
  const fallback = defaultSetupAnalysis(context);

  return callGroqJson(
    buildSetupPrompt(),
    context,
    (value) => normalizeSetupAnalysis(value, context),
    fallback
  );
}

export async function parsePolicyText(input) {
  const fallback = {
    ...buildFallbackPolicy(input),
    policyText: String(input.policyText || ''),
    supportedActions: Array.isArray(input.supportedActions) ? input.supportedActions : [],
  };

  return callGroqJson(
    buildPolicyPrompt(),
    input,
    (value) => normalizePolicyResponse(value, input),
    fallback
  );
}

export async function askLLM(context) {
  const fallback = fallbackDecision();

  return callGroqJson(
    buildRunPrompt(context),
    context,
    normalizeDecision,
    fallback
  );
}
