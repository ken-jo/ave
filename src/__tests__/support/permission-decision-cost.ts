// Hosted virtual machines measured about twice the local decision cost. This
// fixed test allowance never participates in production permission decisions.
export const permissionDecisionCostTargetMs = process.env.CI === "true" ? 80 : 40;
