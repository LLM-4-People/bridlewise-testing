/**
 * The TEST-ESTATE door onto the engine module resolver. The single owner of
 * "where does an engine module live" is `src/shared/module-location.ts` (the
 * layer the verification scripts can also import); this module re-exports it
 * so engine tests import from the conventional `test/support` path. There is
 * NO second copy of the walk logic here — extending this file means extending
 * the shared owner.
 */
export {
  EngineModuleResolutionError,
  engineModulePath,
  engineModulePathMatching,
  engineModuleRef,
  engineModuleRefMatching,
  engineModuleSourceRelative,
  engineModuleSourceRelativeByNames,
  type EngineModuleRef,
} from "../../src/shared/module-location.ts";
