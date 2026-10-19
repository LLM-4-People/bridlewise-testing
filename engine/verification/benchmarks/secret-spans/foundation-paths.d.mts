import type { CommandEffectContract } from "../shared/command-effect-contract.mjs";

export const SECRET_SPAN_QUALIFICATION_VERSIONS: Readonly<{
  protocol: "bridlewise-secret-span-protocol/v3";
  result: "bridlewise-secret-span-result/v3";
  authorReceipt: "bridlewise-secret-span-author-receipt/v3";
  trustBase: "bridlewise-secret-span-trust-base/v3";
}>;

export const SECRET_SPAN_PATHS: Readonly<{
  packageRoot: string;
  protocol: string;
  protocolSchema: string;
  corpusSchema: string;
  resultSchema: string;
  authorReceiptSchema: string;
  authorReceipt: string;
  authorPin: string;
  evidenceAuthorityRoot: string;
  evidenceRelativeRoot: string;
  exactFalsePositive: Readonly<{
    source: string;
    line: number;
    fixtureId: string;
    admissionSignalId: string;
  }>;
}>;

export const SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS: CommandEffectContract;
export const SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS: CommandEffectContract;
export const SECRET_SPAN_FOUNDATION_ARTIFACTS: readonly string[];
export const SECRET_SPAN_ROOT_PACKAGES: readonly string[];
