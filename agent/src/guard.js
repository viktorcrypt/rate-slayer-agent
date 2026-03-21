import { getDailySpend } from './db.js';

export async function getSpendingSnapshot(agentAddress, gameId, dailyLimitWei) {
  const usedWeiString = await getDailySpend(agentAddress, gameId);
  const usedWei = BigInt(usedWeiString || '0');
  const limitWei = BigInt(String(dailyLimitWei || '0'));
  const remainingBudgetWei = limitWei > usedWei ? limitWei - usedWei : 0n;

  return {
    dailyLimitWei: limitWei.toString(),
    todaySpendWei: usedWei.toString(),
    remainingBudgetWei: remainingBudgetWei.toString(),
  };
}

export async function checkSpendingAllowed(agentAddress, gameId, dailyLimitWei, estimatedSpendWei) {
  const snapshot = await getSpendingSnapshot(agentAddress, gameId, dailyLimitWei);
  const currentWei = BigInt(snapshot.todaySpendWei);
  const limitWei = BigInt(snapshot.dailyLimitWei);
  const estimatedWei = BigInt(String(estimatedSpendWei || '0'));
  const projectedWei = currentWei + estimatedWei;

  if (projectedWei > limitWei) {
    return {
      allowed: false,
      reason: `Daily spend limit exceeded (${projectedWei.toString()} > ${limitWei.toString()} wei)`,
      ...snapshot,
    };
  }

  return {
    allowed: true,
    reason: `Projected spend ${projectedWei.toString()} / ${limitWei.toString()} wei`,
    ...snapshot,
  };
}
