import type {
  ObjectStore,
  ProtocolValidator,
  WorkspaceDataSource,
  WorkspaceMaintenancePort,
} from "../../data/api/index.js";
import type { AutomationProviderPort } from "../../engine/automation/index.js";
import type {
  RuntimeCapturePort,
  RuntimeEventPumpStatus,
} from "../../engine/connection/index.js";
import type { RuntimeTuningPort } from "../../engine/design/index.js";

/** Public composition contracts are isolated from the HTTP route table. */
export type HostLocalApiBindAddress = "127.0.0.1" | "::1";

export interface HostLocalApiDependencies {
  readonly runtime: RuntimeCapturePort;
  /** The live tuning boundary; absent when the composition is Snapshot-only. */
  readonly runtimeTuning?: RuntimeTuningPort;
  /** Reports live Runtime readiness without exposing transport state to API consumers. */
  readonly isRuntimeConnected?: () => boolean;
  /** Reports the Runtime event pump status when the Host composition runs one. */
  readonly runtimeEventsStatus?: () => RuntimeEventPumpStatus | undefined;
  /** Reports Runtime self-reversion audit counts when the composition tracks them. */
  readonly tuningReversionsStatus?: () => { recorded: number; failed: number } | undefined;
  /**
   * The device automation provider exploration runs on; absent when the
   * composition has no configured device, in which case the exploration
   * routes fail closed as unsupported.
   */
  readonly automationProvider?: AutomationProviderPort;
  readonly workspace: WorkspaceDataSource;
  /**
   * Online-safe recovery-point operations. Fixture-only compositions may omit
   * this port; the corresponding routes then fail closed as unsupported.
   */
  readonly maintenance?: WorkspaceMaintenancePort;
  readonly objects: ObjectStore;
  readonly validator: ProtocolValidator;
}

export interface StartHostLocalApiOptions extends HostLocalApiDependencies {
  /** A literal loopback address is required. Hostnames and wildcard addresses fail closed. */
  readonly host: HostLocalApiBindAddress;
  /** Zero asks the operating system for an unused port. */
  readonly port?: number;
  readonly maximumJsonBodyBytes?: number;
}

export interface HostLocalApiHandle {
  readonly host: HostLocalApiBindAddress;
  readonly port: number;
  readonly baseUrl: string;
  /** Generated once for this server lifetime and never written to the Workspace. */
  readonly bearerToken: string;
  close(): Promise<void>;
}
