export {
  AutomationEngine,
  AutomationError,
  boundActionDigest,
  type ActionAuthorization,
  type AutomationActionKind,
  type AutomationActionResult,
  type AutomationActionRisk,
  type AutomationEngineDependencies,
  type AutomationErrorCode,
  type AutomationPoint,
  type AutomationProviderDescriptor,
  type AutomationProviderPort,
  type AutomationRect,
  type AutomationSessionDescriptor,
  type ExecuteSemanticActionCommand,
  type OpenAutomationSessionCommand,
  type ProviderActionCommand,
  type ProviderActionResult,
  type ProviderLocator,
  type ResolvedActionTarget,
  type SemanticActionTarget,
} from "./automation-engine.js";
export {
  AdbAutomationProvider,
  parseDisplayInteractive,
  type AdbAutomationProviderOptions,
} from "./adb-provider.js";
export {
  WdaAutomationProvider,
  WdaRequestError,
  type WdaAutomationProviderOptions,
} from "./wda-provider.js";
