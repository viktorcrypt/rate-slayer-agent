import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

let poolPromise;

function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0
  ));
  const end = new Date(start.getTime() + (24 * 60 * 60 * 1000));

  return {
    dayKey: start.toISOString().slice(0, 10),
    start,
    end,
  };
}

function randomInt(min, max) {
  if (max <= min) {
    return min;
  }

  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeTextArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function clampInteger(value, fallback, min = 0, max = 1000000) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(normalized)));
}

function normalizeGameRow(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    supported_actions: normalizeTextArray(row.supported_actions),
    source_verified: Boolean(row.source_verified),
    daily_free_press_limit: clampInteger(row.daily_free_press_limit, 0),
    daily_paid_press_limit: clampInteger(row.daily_paid_press_limit, 0),
    min_minutes_between_actions: clampInteger(row.min_minutes_between_actions, 60, 1, 1440),
    policy_text: String(row.policy_text || ''),
    setup_summary: String(row.setup_summary || ''),
    daily_limit_wei: String(row.daily_limit_wei || '0'),
  };
}

function normalizeGameInsertInput(nameOrInput, contractAddress, description, dailyLimitWei = '500000000000000', options = {}) {
  const input = typeof nameOrInput === 'object' && nameOrInput !== null
    ? nameOrInput
    : {
      name: nameOrInput,
      contractAddress,
      description,
      dailyLimitWei,
      ...options,
    };

  return {
    name: String(input.name || '').trim(),
    contractAddress: String(input.contractAddress || input.contract_address || '').trim(),
    description: String(input.description || '').trim(),
    dailyLimitWei: String(input.dailyLimitWei || input.daily_limit_wei || dailyLimitWei || '500000000000000'),
    contractName: String(input.contractName || input.contract_name || '').trim(),
    abiJson: input.abiJson ? String(input.abiJson) : '',
    sourceVerified: Boolean(input.sourceVerified ?? input.source_verified ?? false),
    supportedActions: normalizeTextArray(input.supportedActions ?? input.supported_actions),
    policyText: String(input.policyText || input.policy_text || '').trim(),
    dailyFreePressLimit: clampInteger(input.dailyFreePressLimit ?? input.daily_free_press_limit, 10),
    dailyPaidPressLimit: clampInteger(input.dailyPaidPressLimit ?? input.daily_paid_press_limit, 1),
    minMinutesBetweenActions: clampInteger(
      input.minMinutesBetweenActions ?? input.min_minutes_between_actions,
      60,
      1,
      1440
    ),
    setupSummary: String(input.setupSummary || input.setup_summary || '').trim(),
  };
}

export async function getDb() {
  if (!poolPromise) {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required.');
    }

    poolPromise = Promise.resolve(new Pool({
      connectionString: DATABASE_URL,
    }));
  }

  return poolPromise;
}

export async function initDb() {
  const db = await getDb();

  await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await db.query(`
    CREATE TABLE IF NOT EXISTS games (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      contract_address VARCHAR(42) NOT NULL,
      description TEXT NOT NULL,
      daily_limit_wei VARCHAR(30) NOT NULL DEFAULT '500000000000000',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS contract_name VARCHAR(200)`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS abi_json TEXT`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS source_verified BOOLEAN NOT NULL DEFAULT false`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS supported_actions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS policy_text TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS daily_free_press_limit INTEGER NOT NULL DEFAULT 10`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS daily_paid_press_limit INTEGER NOT NULL DEFAULT 1`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS min_minutes_between_actions INTEGER NOT NULL DEFAULT 60`);
  await db.query(`ALTER TABLE games ADD COLUMN IF NOT EXISTS setup_summary TEXT NOT NULL DEFAULT ''`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id UUID REFERENCES games(id),
      agent_address VARCHAR(42) NOT NULL,
      action VARCHAR(20) NOT NULL,
      reason TEXT,
      confidence FLOAT,
      bet_amount_wei VARCHAR(30),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id UUID REFERENCES games(id),
      agent_address VARCHAR(42) NOT NULL,
      tx_hash VARCHAR(66) NOT NULL,
      action VARCHAR(20) NOT NULL,
      eth_spent VARCHAR(30) DEFAULT '0',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS daily_tx_budgets (
      day_key DATE PRIMARY KEY,
      target_transactions INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

export async function getGameById(id) {
  const db = await getDb();
  const result = await db.query('SELECT * FROM games WHERE id = $1', [id]);
  return normalizeGameRow(result.rows[0] || null);
}

export async function getActiveGames() {
  const db = await getDb();
  const result = await db.query(
    'SELECT * FROM games WHERE active = true ORDER BY created_at ASC'
  );
  return result.rows.map(normalizeGameRow);
}

export async function addGame(nameOrInput, contractAddress, description, dailyLimitWei = '500000000000000', options = {}) {
  const db = await getDb();
  const input = normalizeGameInsertInput(nameOrInput, contractAddress, description, dailyLimitWei, options);
  const result = await db.query(
    `INSERT INTO games (
      name,
      contract_address,
      description,
      daily_limit_wei,
      contract_name,
      abi_json,
      source_verified,
      supported_actions,
      policy_text,
      daily_free_press_limit,
      daily_paid_press_limit,
      min_minutes_between_actions,
      setup_summary
    )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.name,
      input.contractAddress,
      input.description,
      input.dailyLimitWei,
      input.contractName || null,
      input.abiJson || null,
      input.sourceVerified,
      input.supportedActions,
      input.policyText,
      input.dailyFreePressLimit,
      input.dailyPaidPressLimit,
      input.minMinutesBetweenActions,
      input.setupSummary,
    ]
  );

  return normalizeGameRow(result.rows[0]);
}

export async function updateGame(id, fields) {
  const db = await getDb();
  const updates = [];
  const values = [id];
  const allowed = {
    name: { column: 'name' },
    contractAddress: { column: 'contract_address' },
    contract_address: { column: 'contract_address' },
    description: { column: 'description' },
    dailyLimitWei: { column: 'daily_limit_wei', transform: (value) => String(value) },
    daily_limit_wei: { column: 'daily_limit_wei', transform: (value) => String(value) },
    active: { column: 'active', transform: (value) => Boolean(value) },
    contractName: { column: 'contract_name' },
    contract_name: { column: 'contract_name' },
    abiJson: { column: 'abi_json', transform: (value) => (value ? String(value) : null) },
    abi_json: { column: 'abi_json', transform: (value) => (value ? String(value) : null) },
    sourceVerified: { column: 'source_verified', transform: (value) => Boolean(value) },
    source_verified: { column: 'source_verified', transform: (value) => Boolean(value) },
    supportedActions: { column: 'supported_actions', transform: normalizeTextArray },
    supported_actions: { column: 'supported_actions', transform: normalizeTextArray },
    policyText: { column: 'policy_text', transform: (value) => String(value || '') },
    policy_text: { column: 'policy_text', transform: (value) => String(value || '') },
    dailyFreePressLimit: { column: 'daily_free_press_limit', transform: (value) => clampInteger(value, 0) },
    daily_free_press_limit: { column: 'daily_free_press_limit', transform: (value) => clampInteger(value, 0) },
    dailyPaidPressLimit: { column: 'daily_paid_press_limit', transform: (value) => clampInteger(value, 0) },
    daily_paid_press_limit: { column: 'daily_paid_press_limit', transform: (value) => clampInteger(value, 0) },
    minMinutesBetweenActions: {
      column: 'min_minutes_between_actions',
      transform: (value) => clampInteger(value, 60, 1, 1440),
    },
    min_minutes_between_actions: {
      column: 'min_minutes_between_actions',
      transform: (value) => clampInteger(value, 60, 1, 1440),
    },
    setupSummary: { column: 'setup_summary', transform: (value) => String(value || '') },
    setup_summary: { column: 'setup_summary', transform: (value) => String(value || '') },
  };

  for (const [key, rawValue] of Object.entries(fields || {})) {
    const config = allowed[key];
    if (!config) {
      continue;
    }

    const value = config.transform ? config.transform(rawValue) : rawValue;
    updates.push(`${config.column} = $${values.length + 1}`);
    values.push(value);
  }

  if (updates.length === 0) {
    return getGameById(id);
  }

  const result = await db.query(
    `UPDATE games SET ${updates.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );

  return normalizeGameRow(result.rows[0] || null);
}

export async function saveDecision(gameId, agentAddress, decision) {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO agent_decisions (game_id, agent_address, action, reason, confidence, bet_amount_wei)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      gameId,
      agentAddress,
      decision.action,
      decision.reason || null,
      decision.confidence ?? null,
      String(decision.betAmountWei || '0'),
    ]
  );

  return result.rows[0];
}

export async function saveTransaction(gameId, agentAddress, txHash, action, ethSpent = '0') {
  const db = await getDb();
  const result = await db.query(
    `INSERT INTO transactions (game_id, agent_address, tx_hash, action, eth_spent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [gameId, agentAddress, txHash, action, String(ethSpent || '0')]
  );

  return result.rows[0];
}

export async function getRecentDecisions(limit = 20) {
  const db = await getDb();
  const result = await db.query(
    `SELECT d.*, g.name AS game_name
     FROM agent_decisions d
     LEFT JOIN games g ON g.id = d.game_id
     ORDER BY d.created_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

export async function getRecentTransactions(limit = 20) {
  const db = await getDb();
  const result = await db.query(
    `SELECT t.*, g.name AS game_name
     FROM transactions t
     LEFT JOIN games g ON g.id = t.game_id
     ORDER BY t.created_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

export async function getDailySpend(agentAddress, gameId, date = new Date()) {
  const db = await getDb();
  const { start, end } = getUtcDayRange(date);
  const result = await db.query(
    `SELECT COALESCE(SUM(eth_spent::numeric), 0)::text AS total
     FROM transactions
     WHERE agent_address = $1
       AND game_id = $2
       AND created_at >= $3
       AND created_at < $4`,
    [agentAddress, gameId, start, end]
  );

  return result.rows[0]?.total || '0';
}

export async function getDailyActionStats(agentAddress, gameId, date = new Date()) {
  const db = await getDb();
  const { start, end } = getUtcDayRange(date);
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS total_actions,
       COUNT(*) FILTER (WHERE action = 'press')::int AS press_count,
       COUNT(*) FILTER (WHERE action = 'pressWithBet')::int AS paid_press_count,
       COALESCE(SUM(eth_spent::numeric), 0)::text AS total_spent_wei,
       MAX(created_at) AS last_action_at
     FROM transactions
     WHERE agent_address = $1
       AND game_id = $2
       AND created_at >= $3
       AND created_at < $4`,
    [agentAddress, gameId, start, end]
  );

  const row = result.rows[0] || {};

  return {
    totalActions: Number(row.total_actions || 0),
    pressCount: Number(row.press_count || 0),
    paidPressCount: Number(row.paid_press_count || 0),
    totalSpentWei: String(row.total_spent_wei || '0'),
    lastActionAt: row.last_action_at || null,
  };
}

export async function getDailySpendSummary(date = new Date()) {
  const db = await getDb();
  const { start, end } = getUtcDayRange(date);
  const result = await db.query(
    `SELECT
       t.game_id,
       t.agent_address,
       COALESCE(SUM(t.eth_spent::numeric), 0)::text AS total_spent_wei,
       g.name AS game_name,
       g.daily_limit_wei
     FROM transactions t
     LEFT JOIN games g ON g.id = t.game_id
     WHERE t.created_at >= $1
       AND t.created_at < $2
     GROUP BY t.game_id, t.agent_address, g.name, g.daily_limit_wei
     ORDER BY g.name ASC NULLS LAST, t.agent_address ASC`,
    [start, end]
  );

  return result.rows;
}

export async function getTodayTransactionCount(date = new Date()) {
  const db = await getDb();
  const { start, end } = getUtcDayRange(date);
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM transactions
     WHERE created_at >= $1
       AND created_at < $2`,
    [start, end]
  );

  return Number(result.rows[0]?.count || 0);
}

export async function getOrCreateDailyBudget(minTransactions, maxTransactions, date = new Date()) {
  const db = await getDb();
  const { dayKey } = getUtcDayRange(date);
  const existing = await db.query(
    'SELECT day_key, target_transactions FROM daily_tx_budgets WHERE day_key = $1::date',
    [dayKey]
  );

  if (existing.rows[0]) {
    return {
      dayKey,
      targetTransactions: Number(existing.rows[0].target_transactions),
    };
  }

  const targetTransactions = randomInt(minTransactions, maxTransactions);
  const created = await db.query(
    `INSERT INTO daily_tx_budgets (day_key, target_transactions)
     VALUES ($1::date, $2)
     ON CONFLICT (day_key) DO UPDATE SET target_transactions = daily_tx_budgets.target_transactions
     RETURNING day_key, target_transactions`,
    [dayKey, targetTransactions]
  );

  return {
    dayKey,
    targetTransactions: Number(created.rows[0].target_transactions),
  };
}

export async function getDailyBudgetStatus(minTransactions, maxTransactions, date = new Date()) {
  const budget = await getOrCreateDailyBudget(minTransactions, maxTransactions, date);
  const sentTransactions = await getTodayTransactionCount(date);

  return {
    dayKey: budget.dayKey,
    targetTransactions: budget.targetTransactions,
    sentTransactions,
  };
}
