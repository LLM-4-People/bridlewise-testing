export type QualificationTrustBaseLease = Readonly<{
  schemaVersion: "bridlewise-qualification-authority-contract/v5";
  leaseId: string;
  trustBaseSchemaVersion: string;
  rootPackages: readonly string[];
  packageDetail: "summary" | "full";
  nodeDetail: "complete" | "legacy";
  rootMetadataPaths: readonly string[];
  preserveRootMetadataOrder: boolean;
  includeAuthorityOwner: boolean;
  packageRootsDerivedInternally: boolean;
  receiptSchemaRelativePath: string;
  receiptTrustBaseJsonPointer: string;
  requiredUseCardinality: number;
  environmentPolicy: Readonly<{ mode: "compiled-source-accesses"; names: readonly string[] }>;
  fieldInfluence: Readonly<Record<string, readonly string[]>>;
  leaseIdentity: string;
}>;

export const QUALIFICATION_AUTHORITY_OWNER: string;
export const QUALIFICATION_AUTHORITY_CONTRACT_SCHEMA_VERSION: string;
export const QUALIFICATION_AUTHORITY_INVENTORY_SCHEMA_VERSION: string;
export function defineQualificationTrustBaseLease(input: Readonly<Record<string, unknown>>):
  QualificationTrustBaseLease;
export function trustBaseDerivationOptions(lease: QualificationTrustBaseLease):
  Readonly<Record<string, unknown>>;
export function classifyQualificationSourceOrigin(relativePath: string):
  "installed-third-party" | "evidence-snapshot" | "vendored-source" |
  "first-party-nonproduction" | "first-party-production" | "repository-auxiliary";
export function qualifyQualificationSourceCarrier(relativePath: string): Readonly<{
  originClass: ReturnType<typeof classifyQualificationSourceOrigin>;
  moduleDisposition: "executable-first-party-module" | "non-executable-carrier";
  dispositionReason: string;
}>;
