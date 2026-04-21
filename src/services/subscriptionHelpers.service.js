const DEFAULT_BILLING_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_PRIORITY = { basic: 1, premium: 2 };

const getPlanPriority = (planType) => PLAN_PRIORITY[planType] || 0;

const toDateFromUnixSeconds = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const date = new Date(numericValue * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDateForResponse = (date) => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().split("T")[0];
};

const getStripePeriodValue = (stripeSubscription, fieldName) => {
  if (!stripeSubscription) return null;
  return (
    stripeSubscription[fieldName] ??
    stripeSubscription.items?.data?.[0]?.[fieldName] ??
    null
  );
};

const getCycleDurationMs = (stripeSubscription) => {
  const periodStart = toDateFromUnixSeconds(
    getStripePeriodValue(stripeSubscription, "current_period_start"),
  );
  const periodEnd = toDateFromUnixSeconds(
    getStripePeriodValue(stripeSubscription, "current_period_end"),
  );
  if (periodStart && periodEnd && periodEnd > periodStart) {
    return periodEnd.getTime() - periodStart.getTime();
  }
  return DEFAULT_BILLING_CYCLE_MS;
};

const getNextExpiryDate = (baseDate, durationMs) => {
  const now = new Date();
  const referenceDate =
    baseDate instanceof Date &&
    !Number.isNaN(baseDate.getTime()) &&
    baseDate > now
      ? baseDate
      : now;

  return new Date(referenceDate.getTime() + durationMs);
};

const getPlanDurationMs = (subscription, now = new Date()) => {
  if (!subscription) return 0;

  const startDate =
    subscription.startDate instanceof Date ? subscription.startDate : null;
  const expiryDate =
    subscription.expiryDate instanceof Date ? subscription.expiryDate : null;

  if (!expiryDate) {
    return DEFAULT_BILLING_CYCLE_MS;
  }

  if (startDate && expiryDate > startDate) {
    return expiryDate.getTime() - startDate.getTime();
  }

  return Math.max(0, expiryDate.getTime() - now.getTime());
};

const mapStripeStatusToDb = (stripeStatus) =>
  stripeStatus === "trialing" ? "scheduled" : stripeStatus;

export {
  DEFAULT_BILLING_CYCLE_MS,
  getPlanPriority,
  toDateFromUnixSeconds,
  formatDateForResponse,
  getStripePeriodValue,
  getCycleDurationMs,
  getNextExpiryDate,
  getPlanDurationMs,
  mapStripeStatusToDb,
};
