import {
  DataError,
  type IdGenerator,
  type ReleaseWorkspaceRecoveryPointCommand,
  type WorkspaceMaintenancePort,
  type WorkspaceRecoveryPoint,
} from "../../data/api/index.js";
import { SecureUuidV7IdGenerator } from "../design/index.js";

const MANUAL_RETENTION_REASON =
  "Keep this manual Workspace recovery point until it is explicitly released.";

export interface WorkspaceMaintenanceEngineDependencies {
  readonly maintenance: WorkspaceMaintenancePort;
  readonly ids?: IdGenerator;
}

export interface CreateWorkspaceRecoveryPointCommand {
  readonly reason: string;
}

/**
 * Applies product policy to online-safe Workspace recovery-point operations.
 *
 * Concrete Object Store lifecycle metadata remains inside Data. Adapters see
 * stable recovery-point values and never synthesize retention policies.
 */
export class WorkspaceMaintenanceEngine {
  readonly #maintenance: WorkspaceMaintenancePort;
  readonly #ids: IdGenerator;

  constructor(dependencies: WorkspaceMaintenanceEngineDependencies) {
    this.#maintenance = dependencies.maintenance;
    this.#ids = dependencies.ids ?? new SecureUuidV7IdGenerator();
  }

  async createRecoveryPoint(
    command: CreateWorkspaceRecoveryPointCommand,
  ): Promise<WorkspaceRecoveryPoint> {
    assertReason(command.reason);
    return await this.#maintenance.createRecoveryPoint({
      reason: command.reason,
      source: "manual",
      retention: {
        policy_id: `workspace-recovery:${this.#ids.next("recovery")}`,
        reason: MANUAL_RETENTION_REASON,
      },
    });
  }

  async listRecoveryPoints(): Promise<readonly WorkspaceRecoveryPoint[]> {
    return await this.#maintenance.listRecoveryPoints();
  }

  async releaseRecoveryPoint(
    command: ReleaseWorkspaceRecoveryPointCommand,
  ): Promise<WorkspaceRecoveryPoint> {
    return await this.#maintenance.releaseRecoveryPoint(command);
  }
}

function assertReason(reason: string): void {
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > 1_024) {
    throw new DataError(
      "invalid_argument",
      "Recovery-point reason must contain 1 to 1024 characters.",
    );
  }
}
