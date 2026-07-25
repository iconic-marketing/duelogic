/**
 * DueLogic declarative policy values.
 *
 * Values only: no functions, branching, date calculations, explanation
 * builders, Pinch references or environment access. Every threshold the
 * policy engine evaluates lives in this one object, and the engine always
 * reads the supplied policy (defaulting to this object), so a
 * merchant-specific policy can override any value — including
 * amountCeilingCents — without engine changes. Readonly through the
 * DueLogicPolicy type; no runtime freezing, matching repository convention.
 */

import type { DueLogicPolicy } from "../schema";

export const DEFAULT_DUELOGIC_POLICY: DueLogicPolicy = {
  version: "duelogic-default-v1",

  amountCeilingCents: 50000,

  temporaryChange: {
    maxVerifiedUses: 2,
    rollingPeriodMonths: 12,
    maxShiftDays: 5,
  },

  permanentChange: {
    maxVerifiedUses: 1,
    rollingPeriodMonths: 12,

    supportedCadences: ["weekly", "fortnightly", "monthly"],

    keepPaymentWithinAssignedCycle: true,

    cycleLengthDays: {
      weekly: 7,
      fortnightly: 14,
    },

    monthlyAnchorDay: {
      minimum: 1,
      maximum: 28,
    },

    allowSameDayCurrentCycleChange: false,

    closePaymentWarningDays: {
      weekly: 3,
      fortnightly: 5,
      monthly: 7,
    },

    closePaymentAction: "warn-and-confirm",
    unsupportedCadenceAction: "escalate",
    overLimitAction: "escalate",
  },

  arrears: {
    disqualifyWhenCurrentArrearsCentsAbove: 0,
    action: "escalate",
  },
};
