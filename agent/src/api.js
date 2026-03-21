import express from 'express';

import { createAgentContexts } from './executor.js';
import {
  addGame,
  getActiveGames,
  getDailySpendSummary,
  getGameById,
  getRecentDecisions,
  getRecentTransactions,
  updateGame,
} from './db.js';
import { inspectGameContract, parseGamePolicy } from './setup.js';

const PORT = Number(process.env.PORT || 3001);

let serverPromise;

function getAgentAddresses(providedAgents) {
  const agents = providedAgents && providedAgents.length > 0
    ? providedAgents
    : createAgentContexts();

  return agents.map((agent) => agent.account.address);
}

function sendError(res, error, fallbackMessage, statusCode = 500) {
  res.status(statusCode).json({ error: error?.message || fallbackMessage });
}

export async function startApiServer(providedAgents = [], hooks = {}) {
  if (serverPromise) {
    return serverPromise;
  }

  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/state', async (_req, res) => {
    try {
      res.json({
        games: await getActiveGames(),
        recentDecisions: await getRecentDecisions(),
        recentTransactions: await getRecentTransactions(),
        dailySpending: await getDailySpendSummary(),
        agents: getAgentAddresses(providedAgents),
      });
    } catch (error) {
      sendError(res, error, 'Failed to load state');
    }
  });

  app.get('/games', async (_req, res) => {
    try {
      res.json(await getActiveGames());
    } catch (error) {
      sendError(res, error, 'Failed to load games');
    }
  });

  app.post('/contracts/inspect', async (req, res) => {
    const { contractAddress } = req.body || {};

    try {
      const inspection = await inspectGameContract(contractAddress);
      res.json(inspection);
    } catch (error) {
      sendError(res, error, 'Failed to inspect contract', 400);
    }
  });

  app.post('/policies/parse', async (req, res) => {
    const {
      policyText,
      supportedActions,
      dailyLimitWei,
      minMinutesBetweenActions,
    } = req.body || {};

    try {
      const parsed = await parseGamePolicy({
        policyText,
        supportedActions,
        defaultDailyLimitWei: dailyLimitWei,
        defaultMinMinutesBetweenActions: minMinutesBetweenActions,
      });

      res.json(parsed);
    } catch (error) {
      sendError(res, error, 'Failed to parse policy', 400);
    }
  });

  app.post('/games', async (req, res) => {
    const {
      contractAddress,
      name,
      description,
      policyText,
      dailyLimitWei,
      dailyFreePressLimit,
      dailyPaidPressLimit,
      minMinutesBetweenActions,
    } = req.body || {};

    try {
      const inspection = await inspectGameContract(contractAddress);
      if (!inspection.runtimeCompatible) {
        res.status(400).json({
          error: `Inspect-only contract. Missing runtime functions: ${inspection.missingRequiredFunctions.join(', ')}`,
          inspection,
        });
        return;
      }

      const parsedPolicy = await parseGamePolicy({
        policyText,
        supportedActions: inspection.supportedActions,
        defaultDailyLimitWei: dailyLimitWei || '500000000000000',
        defaultMinMinutesBetweenActions: minMinutesBetweenActions || 60,
      });

      const created = await addGame({
        name: name || inspection.nameSuggestion,
        contractAddress,
        description: description || inspection.description,
        dailyLimitWei: parsedPolicy.dailyLimitWei,
        contractName: inspection.contractName,
        abiJson: inspection.abiJson,
        sourceVerified: inspection.sourceVerified,
        supportedActions: inspection.supportedActions,
        policyText: policyText || parsedPolicy.summary,
        dailyFreePressLimit: dailyFreePressLimit ?? parsedPolicy.dailyPressLimit,
        dailyPaidPressLimit: dailyPaidPressLimit ?? parsedPolicy.dailyPaidPressLimit,
        minMinutesBetweenActions: minMinutesBetweenActions ?? parsedPolicy.minMinutesBetweenActions,
        setupSummary: inspection.setupSummary,
      });

      const activation = hooks.onGameCreated
        ? await hooks.onGameCreated(created)
        : null;

      res.status(201).json({
        game: created,
        inspection,
        parsedPolicy,
        activation,
      });
    } catch (error) {
      sendError(res, error, 'Failed to create game', 400);
    }
  });

  app.patch('/games/:id', async (req, res) => {
    try {
      const existing = await getGameById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      let updateFields = { ...req.body };

      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'policyText') && !Object.prototype.hasOwnProperty.call(req.body || {}, 'policy_text')) {
        updateFields.policy_text = req.body.policyText;
      }

      if (updateFields.policy_text || updateFields.policyText) {
        const parsedPolicy = await parseGamePolicy({
          policyText: updateFields.policy_text || updateFields.policyText,
          supportedActions: existing.supported_actions,
          defaultDailyLimitWei: updateFields.dailyLimitWei || updateFields.daily_limit_wei || existing.daily_limit_wei,
          defaultMinMinutesBetweenActions:
            updateFields.minMinutesBetweenActions ||
            updateFields.min_minutes_between_actions ||
            existing.min_minutes_between_actions,
        });

        updateFields = {
          ...updateFields,
          daily_limit_wei: updateFields.dailyLimitWei || updateFields.daily_limit_wei || parsedPolicy.dailyLimitWei,
          daily_free_press_limit:
            updateFields.dailyFreePressLimit ??
            updateFields.daily_free_press_limit ??
            parsedPolicy.dailyPressLimit,
          daily_paid_press_limit:
            updateFields.dailyPaidPressLimit ??
            updateFields.daily_paid_press_limit ??
            parsedPolicy.dailyPaidPressLimit,
          min_minutes_between_actions:
            updateFields.minMinutesBetweenActions ??
            updateFields.min_minutes_between_actions ??
            parsedPolicy.minMinutesBetweenActions,
        };
      }

      const updated = await updateGame(req.params.id, updateFields);
      if (!updated) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      const sync = hooks.onGameUpdated
        ? await hooks.onGameUpdated(updated, existing)
        : null;

      res.json({
        game: updated,
        sync,
      });
    } catch (error) {
      sendError(res, error, 'Failed to update game', 400);
    }
  });

  app.delete('/games/:id', async (req, res) => {
    try {
      const existing = await getGameById(req.params.id);
      if (!existing) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      const updated = await updateGame(req.params.id, { active: false });
      if (!updated) {
        res.status(404).json({ error: 'Game not found' });
        return;
      }

      const sync = hooks.onGameUpdated
        ? await hooks.onGameUpdated(updated, existing)
        : null;

      res.json({
        game: updated,
        sync,
      });
    } catch (error) {
      sendError(res, error, 'Failed to deactivate game');
    }
  });

  serverPromise = new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`API server listening on port ${PORT}`);
      resolve(server);
    });
  });

  return serverPromise;
}
