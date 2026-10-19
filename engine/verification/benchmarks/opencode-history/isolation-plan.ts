import { canonicalHash } from "../../../src/kernel/integrity.ts";
import { ScopeGuardError } from "./scope-guard.ts";

export const REQUIRED_OS_TOOLS = Object.freeze(["mount", "node", "setpriv", "unshare"] as const);

export interface IsolationCapabilityDeclarations {
  readonly platform: string;
  readonly declaredEffectiveUid: number | undefined;
  readonly targetUid: number;
  readonly declaredAvailableTools: readonly string[];
  readonly declaresMountNamespace: boolean;
  readonly declaresUserNamespace: boolean;
  readonly declaresReadOnlyBindMount: boolean;
  readonly declaresNetworkNamespace: boolean;
  readonly declaresNoNewPrivileges: boolean;
  readonly declaresSeparateOsIdentity: boolean;
}

export interface IsolationPlanReceipt {
  readonly planSha256: string;
  readonly requiredToolCount: number;
  readonly declaredAvailableToolCount: number;
  readonly callerDeclarationsOnly: true;
  readonly measuredCapabilityCount: 0;
  readonly isolationVerified: false;
  readonly rootRunnerRequired: true;
  readonly separateOsIdentityRequired: true;
  readonly readOnlyMountRequired: true;
  readonly networkIsolationRequired: true;
  readonly ready: false;
}

export class IsolationPlanError extends Error {
  readonly code:
    | "isolation_declaration_incomplete"
    | "isolation_identity_mismatch"
    | "isolation_invalid_identity"
    | "isolation_root_runner_required";

  constructor(code: IsolationPlanError["code"]) {
    super(code);
    this.name = "IsolationPlanError";
    this.code = code;
  }
}

export function prepareIsolationPlanFromDeclarations(
  declarations: IsolationCapabilityDeclarations,
): IsolationPlanReceipt {
  if (declarations.declaredEffectiveUid !== 0) {
    throw new IsolationPlanError("isolation_root_runner_required");
  }
  if (declarations.targetUid <= 0 || declarations.targetUid === declarations.declaredEffectiveUid) {
    throw new IsolationPlanError("isolation_invalid_identity");
  }
  const available = new Set(declarations.declaredAvailableTools);
  if (REQUIRED_OS_TOOLS.some((tool) => !available.has(tool))) {
    throw new IsolationPlanError("isolation_declaration_incomplete");
  }
  if (
    declarations.platform !== "linux" ||
    !declarations.declaresMountNamespace ||
    !declarations.declaresUserNamespace ||
    !declarations.declaresReadOnlyBindMount ||
    !declarations.declaresNetworkNamespace ||
    !declarations.declaresNoNewPrivileges ||
    !declarations.declaresSeparateOsIdentity
  ) {
    throw new IsolationPlanError("isolation_declaration_incomplete");
  }

  const plan = Object.freeze({
    filesystem: "private-mount-namespace-with-exact-root-bind-mounted-read-only",
    process: "separate-non-root-uid-gid-with-no-new-privileges",
    network: "private-network-namespace-with-no-interfaces",
    workingDirectory: "empty-private-tmpfs",
    inputs: "preopened-anonymous-control-fd-only",
    outputs: "preopened-content-free-receipt-fd-only",
    tools: REQUIRED_OS_TOOLS,
  });
  return Object.freeze({
    planSha256: canonicalHash(plan),
    requiredToolCount: REQUIRED_OS_TOOLS.length,
    declaredAvailableToolCount: REQUIRED_OS_TOOLS.length,
    callerDeclarationsOnly: true,
    measuredCapabilityCount: 0,
    isolationVerified: false,
    rootRunnerRequired: true,
    separateOsIdentityRequired: true,
    readOnlyMountRequired: true,
    networkIsolationRequired: true,
    ready: false,
  });
}

export function assertMeasuredRootIdentity(
  declarations: IsolationCapabilityDeclarations,
  measuredEffectiveUid: number | undefined,
): void {
  if (measuredEffectiveUid !== 0) throw new IsolationPlanError("isolation_root_runner_required");
  if (declarations.declaredEffectiveUid !== measuredEffectiveUid) {
    throw new IsolationPlanError("isolation_identity_mismatch");
  }
}

export interface SterileProcessSurface {
  readonly controlFd: number;
  readonly receiptFd: number;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function assertSterileProcessSurface(surface: SterileProcessSurface): void {
  if (
    !Number.isInteger(surface.controlFd) ||
    !Number.isInteger(surface.receiptFd) ||
    surface.controlFd < 3 ||
    surface.receiptFd < 3 ||
    surface.controlFd === surface.receiptFd
  ) {
    throw new ScopeGuardError("scope_ambiguous");
  }
  if (surface.argv.length !== 0) throw new ScopeGuardError("scope_unlisted_denied");
  if (Object.keys(surface.environment).length !== 0) throw new ScopeGuardError("scope_unlisted_denied");
}
