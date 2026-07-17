import assert from "node:assert/strict";
import test from "node:test";

import {
  DataError,
  type BackupWorkspaceCommand,
  type IdGenerator,
  type ReleaseWorkspaceRecoveryPointCommand,
  type WorkspaceMaintenancePort,
  type WorkspaceRecoveryPoint,
} from "../../data/api/index.js";
import { WorkspaceMaintenanceEngine } from "../../engine/workspace/index.js";

const point = {
  recovery_point_id: `sha256:${"a".repeat(64)}`,
  backup: {
    hash: `sha256:${"a".repeat(64)}`,
    media_type: "application/vnd.vistrea.workspace-metadata-backup+sqlite3",
    byte_size: 1_024,
    compression: "none",
    extensions: {},
  },
  source: "manual",
  reason: "Before an experiment.",
  created_at: "2026-07-17T04:00:00.000Z",
  schema_version: 1,
  generation: 7,
  retention_policies: [],
  active_retention_policy_ids: [],
} as unknown as WorkspaceRecoveryPoint;

test("Workspace Maintenance Engine owns manual recovery-point retention policy", async () => {
  const maintenance = new RecordingMaintenancePort();
  const engine = new WorkspaceMaintenanceEngine({
    maintenance,
    ids: new FixedIDs(),
  });

  assert.equal(await engine.createRecoveryPoint({ reason: "Before an experiment." }), point);
  assert.deepEqual(maintenance.created, [
    {
      reason: "Before an experiment.",
      source: "manual",
      retention: {
        policy_id: "workspace-recovery:recovery_00000000-0000-7000-8000-000000000001",
        reason: "Keep this manual Workspace recovery point until it is explicitly released.",
      },
    },
  ]);
  assert.deepEqual(await engine.listRecoveryPoints(), [point]);

  const release = {
    recovery_point_id: point.recovery_point_id,
    retention_policy_id: "workspace-recovery:test",
  };
  assert.equal(await engine.releaseRecoveryPoint(release), point);
  assert.deepEqual(maintenance.released, [release]);
});

test("Workspace Maintenance Engine rejects an empty recovery-point reason", async () => {
  const engine = new WorkspaceMaintenanceEngine({
    maintenance: new RecordingMaintenancePort(),
    ids: new FixedIDs(),
  });
  await assert.rejects(engine.createRecoveryPoint({ reason: "   " }), (error: unknown) => {
    return error instanceof DataError && error.code === "invalid_argument";
  });
});

class FixedIDs implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}_00000000-0000-7000-8000-000000000001`;
  }
}

class RecordingMaintenancePort implements WorkspaceMaintenancePort {
  readonly created: BackupWorkspaceCommand[] = [];
  readonly released: ReleaseWorkspaceRecoveryPointCommand[] = [];

  createRecoveryPoint(command: BackupWorkspaceCommand): Promise<WorkspaceRecoveryPoint> {
    this.created.push(command);
    return Promise.resolve(point);
  }

  listRecoveryPoints(): Promise<readonly WorkspaceRecoveryPoint[]> {
    return Promise.resolve([point]);
  }

  releaseRecoveryPoint(
    command: ReleaseWorkspaceRecoveryPointCommand,
  ): Promise<WorkspaceRecoveryPoint> {
    this.released.push(command);
    return Promise.resolve(point);
  }
}
