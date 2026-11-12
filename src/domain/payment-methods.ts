import { daysBetween, getCardExpiryDate } from './dates';
import type { IsoDate, PaymentMethod, PaymentMethodKind, Service } from './types';

/** Maximum number of payment methods allowed in a funding chain (inclusive of leaf and root). */
export const MAX_FUNDING_CHAIN_DEPTH = 5;

export type FundingValidationResult =
  | { valid: true; depth: number }
  | { valid: false; reason: 'card_cannot_be_funded' | 'self_reference' | 'target_not_found' | 'cycle_detected' | 'max_depth_exceeded' };

export type PaymentMethodHealthIssue =
  | 'missing_method'
  | 'archived_method'
  | 'expired_card'
  | 'broken_chain'
  | 'cycle_in_chain';

export interface PaymentMethodHealth {
  healthy: boolean;
  issue: PaymentMethodHealthIssue | null;
  affectedMethod: PaymentMethod | null;
  chain: PaymentMethod[];
  expiryDate: IsoDate | null;
}

export interface CardExpiryAlert {
  method: PaymentMethod;
  expiryDate: IsoDate;
  daysRemaining: number;
  isExpired: boolean;
  matchedThresholdDays: number | null;
}

export interface IntermediaryMigrationGroup {
  intermediary: PaymentMethod;
  dependentServices: Service[];
}

export interface CardMigrationPlan {
  oldMethod: PaymentMethod;
  directServices: Service[];
  intermediaries: IntermediaryMigrationGroup[];
}

function indexActiveMethods(methods: readonly PaymentMethod[]): Map<string, PaymentMethod> {
  const map = new Map<string, PaymentMethod>();
  for (const method of methods) {
    if (method.deletedAt === null) {
      map.set(method.id, method);
    }
  }
  return map;
}

/**
 * Validates setting `fundedById` on a payment method (new or existing) against
 * kind restrictions, cycles, and the maximum chain depth of 5.
 */
export function validateFundingChain(
  methods: readonly PaymentMethod[],
  methodId: string,
  methodKind: PaymentMethodKind,
  candidateFundedById: string | null,
): FundingValidationResult {
  if (candidateFundedById === null) {
    return { valid: true, depth: 1 };
  }
  if (methodKind === 'card') {
    return { valid: false, reason: 'card_cannot_be_funded' };
  }
  if (candidateFundedById === methodId) {
    return { valid: false, reason: 'self_reference' };
  }

  const activeById = indexActiveMethods(methods);
  if (!activeById.has(candidateFundedById)) {
    return { valid: false, reason: 'target_not_found' };
  }

  // Walk upward from candidateFundedById to detect cycles reaching methodId (or existing cycles).
  const visited = new Set<string>([methodId]);
  let currentId: string | null = candidateFundedById;
  let upwardDepth = 1; // methodId itself counts as level 1

  while (currentId !== null) {
    if (visited.has(currentId)) {
      return { valid: false, reason: 'cycle_detected' };
    }
    visited.add(currentId);
    upwardDepth += 1;
    if (upwardDepth > MAX_FUNDING_CHAIN_DEPTH) {
      return { valid: false, reason: 'max_depth_exceeded' };
    }
    const current = activeById.get(currentId);
    if (!current) {
      return { valid: false, reason: 'target_not_found' };
    }
    currentId = current.fundedById;
  }

  // Also ensure adding this upward chain does not push any downstream child over MAX_FUNDING_CHAIN_DEPTH.
  const maxDownstream = computeMaxDownstreamDepth(activeById, methodId, new Set([methodId]));
  const totalMaxDepth = maxDownstream - 1 + upwardDepth;
  if (totalMaxDepth > MAX_FUNDING_CHAIN_DEPTH) {
    return { valid: false, reason: 'max_depth_exceeded' };
  }

  return { valid: true, depth: upwardDepth };
}

function computeMaxDownstreamDepth(
  activeById: Map<string, PaymentMethod>,
  rootId: string,
  seen: Set<string>,
): number {
  let maxChildDepth = 0;
  for (const method of activeById.values()) {
    if (method.fundedById === rootId && !seen.has(method.id)) {
      seen.add(method.id);
      const childDepth = computeMaxDownstreamDepth(activeById, method.id, seen);
      if (childDepth > maxChildDepth) {
        maxChildDepth = childDepth;
      }
    }
  }
  return 1 + maxChildDepth;
}

/**
 * Evaluates the full funding chain of a payment method to determine whether
 * it can currently pay (no missing, archived, or expired methods in the chain).
 */
export function resolvePaymentMethodHealth(
  methods: readonly PaymentMethod[],
  methodId: string | null,
  today: IsoDate,
): PaymentMethodHealth {
  if (methodId === null) {
    return {
      healthy: false,
      issue: 'missing_method',
      affectedMethod: null,
      chain: [],
      expiryDate: null,
    };
  }

  const activeById = indexActiveMethods(methods);
  const chain: PaymentMethod[] = [];
  const visited = new Set<string>();
  let currentId: string | null = methodId;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      return {
        healthy: false,
        issue: 'cycle_in_chain',
        affectedMethod: chain[chain.length - 1] ?? null,
        chain,
        expiryDate: null,
      };
    }
    visited.add(currentId);

    const method = activeById.get(currentId);
    if (!method) {
      return {
        healthy: false,
        issue: chain.length === 0 ? 'missing_method' : 'broken_chain',
        affectedMethod: chain[chain.length - 1] ?? null,
        chain,
        expiryDate: null,
      };
    }
    chain.push(method);

    if (method.archivedAt !== null) {
      return {
        healthy: false,
        issue: 'archived_method',
        affectedMethod: method,
        chain,
        expiryDate: null,
      };
    }

    if (
      method.kind === 'card' &&
      method.expiryMonth !== null &&
      method.expiryYear !== null
    ) {
      const expiryDate = getCardExpiryDate(method.expiryMonth, method.expiryYear);
      if (expiryDate < today) {
        return {
          healthy: false,
          issue: 'expired_card',
          affectedMethod: method,
          chain,
          expiryDate,
        };
      }
      return {
        healthy: true,
        issue: null,
        affectedMethod: null,
        chain,
        expiryDate,
      };
    }

    currentId = method.fundedById;
  }

  return {
    healthy: true,
    issue: null,
    affectedMethod: null,
    chain,
    expiryDate: null,
  };
}

/**
 * Returns alerts for active, non-archived cards that are expired or within any configured threshold.
 */
export function evaluateCardExpiryAlerts(
  methods: readonly PaymentMethod[],
  today: IsoDate,
  thresholdsDays: readonly number[] = [60, 30, 7],
): CardExpiryAlert[] {
  const sortedThresholds = [...thresholdsDays]
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  const maxThreshold = sortedThresholds[sortedThresholds.length - 1] ?? 0;

  const alerts: CardExpiryAlert[] = [];

  for (const method of methods) {
    if (
      method.deletedAt !== null ||
      method.archivedAt !== null ||
      method.kind !== 'card' ||
      method.expiryMonth === null ||
      method.expiryYear === null
    ) {
      continue;
    }

    const expiryDate = getCardExpiryDate(method.expiryMonth, method.expiryYear);
    const daysRemaining = daysBetween(today, expiryDate);
    const isExpired = daysRemaining < 0;

    if (!isExpired && daysRemaining > maxThreshold) {
      continue;
    }

    const matchedThresholdDays = isExpired
      ? null
      : (sortedThresholds.find((threshold) => daysRemaining <= threshold) ?? null);

    alerts.push({
      method,
      expiryDate,
      daysRemaining,
      isExpired,
      matchedThresholdDays,
    });
  }

  return alerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
}

/**
 * Builds the migration checklist for an expiring or replaced payment method:
 * - Direct non-cancelled, non-deleted services (`subscription` & `on_demand`)
 * - Non-archived intermediaries funded directly by `oldMethodId`, along with
 *   all non-cancelled services routed through them (directly or transitively).
 */
export function buildCardMigrationPlan(
  oldMethodId: string,
  methods: readonly PaymentMethod[],
  services: readonly Service[],
): CardMigrationPlan {
  const activeById = indexActiveMethods(methods);
  const oldMethod = activeById.get(oldMethodId);
  if (!oldMethod) {
    throw new Error(`Payment method "${oldMethodId}" not found or deleted.`);
  }

  const eligibleServices = services.filter(
    (s) => s.deletedAt === null && s.status !== 'cancelled',
  );

  const directServices = eligibleServices
    .filter((s) => s.paymentMethodId === oldMethodId)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Direct non-archived intermediaries funded by oldMethodId.
  const directIntermediaries = Array.from(activeById.values())
    .filter((m) => m.archivedAt === null && m.fundedById === oldMethodId)
    .sort((a, b) => a.name.localeCompare(b.name));

  const intermediaries: IntermediaryMigrationGroup[] = directIntermediaries.map(
    (intermediary) => {
      const subtreeIds = collectSubtreeMethodIds(activeById, intermediary.id);
      const dependentServices = eligibleServices
        .filter((s) => s.paymentMethodId !== null && subtreeIds.has(s.paymentMethodId))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        intermediary,
        dependentServices,
      };
    },
  );

  return {
    oldMethod,
    directServices,
    intermediaries,
  };
}

function collectSubtreeMethodIds(
  activeById: Map<string, PaymentMethod>,
  rootId: string,
): Set<string> {
  const result = new Set<string>([rootId]);
  const queue = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const method of activeById.values()) {
      if (
        method.archivedAt === null &&
        method.fundedById === currentId &&
        !result.has(method.id)
      ) {
        result.add(method.id);
        queue.push(method.id);
      }
    }
  }

  return result;
}

