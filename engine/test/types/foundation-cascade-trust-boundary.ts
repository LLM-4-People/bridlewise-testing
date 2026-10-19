import {
  compileFoundationPlan,
  parseUntrustedFoundationPlanBytes,
  type FoundationPlan,
  type FoundationPlanCandidateDocument,
} from "../../verification/core/foundation-cascade.ts";

const trusted: FoundationPlan = compileFoundationPlan();
const parsed = parseUntrustedFoundationPlanBytes(new Uint8Array());

// @ts-expect-error parsed candidates are not trusted plans
const parsedAsTrusted: FoundationPlan = parsed;
const structuralClone: FoundationPlanCandidateDocument = structuredClone(trusted);
// @ts-expect-error structural clones are not trusted plans
const cloneAsTrusted: FoundationPlan = structuralClone;
// @ts-expect-error serialized values are unknown and not trusted plans
const serializedAsTrusted: FoundationPlan = JSON.parse(JSON.stringify(trusted)) as unknown;

void parsedAsTrusted;
void cloneAsTrusted;
void serializedAsTrusted;
