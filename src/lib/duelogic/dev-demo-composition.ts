/**
 * Development wiring for demo preparation: composes the SHARED
 * process-local dev stores, the shared targeted-deletion helpers, the
 * real token functions and the server clock into the dependency object
 * `prepareDemo` needs. Used by the localhost-only demo route and the Demo
 * Setup page only.
 *
 * Nothing here touches Pinch: the composition wires stores and pure
 * functions exclusively, so demo preparation cannot make a Pinch call by
 * construction.
 */

import { randomUUID } from "node:crypto";
import type { DemoPreparationDeps } from "./demo-preparation";
import { getDevDemoManifestRepository } from "./dev-demo-store";
import {
  deleteInterventionNotificationsById,
  deleteInterventionRecordsById,
  getDevInterventionNotificationRepository,
  getDevInterventionRepository,
} from "./dev-intervention-store";
import {
  deleteFixturePaymentsById,
  deleteMovementChoicesForInterventions,
  getDevFixturePaymentRepository,
} from "./dev-movement-store";
import { deleteOtpChallengesForInterventions } from "./dev-otp-store";
import { deleteSmsMessagesForInterventions } from "./dev-sms-store";
import {
  deleteTemporaryConfirmationsForInterventions,
  deleteTemporaryOperationsByIdOrIntervention,
  deleteTemporarySelectionsForInterventions,
  deleteTemporaryVerificationsForInterventions,
  getDevTemporaryOperationRepository,
  getDevTemporarySelectionRepository,
} from "./dev-temporary-operation-store";
import { deleteTransactionVerificationsForInterventions } from "./dev-transaction-verification-store";
import {
  generateInterventionToken,
  hashInterventionToken,
} from "./intervention-service";
import { getDevMerchantPolicyRepository } from "./policy/dev-policy-store";

// Mirrors the runtime server-only guard in src/lib/pinch/client.ts.
if (typeof window !== "undefined") {
  throw new Error(
    "The dev demo composition is server-only and must not be imported into browser code.",
  );
}

export async function buildDevDemoPreparationDeps(): Promise<DemoPreparationDeps> {
  return {
    interventions: getDevInterventionRepository(),
    notifications: getDevInterventionNotificationRepository(),
    fixturePayments: getDevFixturePaymentRepository(),
    temporarySelections: getDevTemporarySelectionRepository(),
    temporaryOperations: getDevTemporaryOperationRepository(),
    policies: await getDevMerchantPolicyRepository(),
    manifests: getDevDemoManifestRepository(),
    deletions: {
      interventionsById: (ids) => deleteInterventionRecordsById(ids),
      notificationsById: (ids) => deleteInterventionNotificationsById(ids),
      fixturePaymentsById: (ids) => deleteFixturePaymentsById(ids),
      movementChoicesForInterventions: (ids) =>
        deleteMovementChoicesForInterventions(ids),
      temporarySelectionsForInterventions: (ids) =>
        deleteTemporarySelectionsForInterventions(ids),
      temporaryVerificationsForInterventions: (ids) =>
        deleteTemporaryVerificationsForInterventions(ids),
      temporaryConfirmationsForInterventions: (ids) =>
        deleteTemporaryConfirmationsForInterventions(ids),
      temporaryOperationsByIdOrIntervention: (operationIds, interventionIds) =>
        deleteTemporaryOperationsByIdOrIntervention(
          operationIds,
          interventionIds,
        ),
      otpChallengesForInterventions: (ids) =>
        deleteOtpChallengesForInterventions(ids),
      smsMessagesForInterventions: (ids) =>
        deleteSmsMessagesForInterventions(ids),
      transactionVerificationsForInterventions: (ids) =>
        deleteTransactionVerificationsForInterventions(ids),
    },
    now: () => new Date().toISOString(),
    generateDemoRunId: () => `demo-${randomUUID()}`,
    generateToken: generateInterventionToken,
    hashToken: hashInterventionToken,
  };
}
