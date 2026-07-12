import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import { startLocalHost, type HostLocalApiBindAddress } from "./index.js";

interface ServeArguments {
  readonly workspaceRoot: string;
  readonly connectionFile: string;
  readonly host: HostLocalApiBindAddress;
  readonly runtimePort?: number;
  readonly apiPort?: number;
}

interface ConnectionDescriptor {
  readonly format_version: 1;
  readonly process_id: number;
  readonly workspace_root: string;
  readonly api: {
    readonly base_url: string;
    readonly bearer_token: string;
  };
  readonly runtime: {
    readonly host: HostLocalApiBindAddress;
    readonly port: number;
    readonly authorization_token: string;
  };
}

async function main(): Promise<void> {
  const argumentsValue = parseArguments(process.argv.slice(2));
  const validator = await createRepositoryProtocolValidator({ repositoryRoot: process.cwd() });
  const host = await startLocalHost({
    workspaceRoot: argumentsValue.workspaceRoot,
    validator,
    host: argumentsValue.host,
    ...(argumentsValue.runtimePort === undefined
      ? {}
      : { runtimePort: argumentsValue.runtimePort }),
    ...(argumentsValue.apiPort === undefined ? {} : { apiPort: argumentsValue.apiPort }),
    applicationVersion: "0.0.0",
  });

  let descriptorWritten = false;
  try {
    await writePrivateDescriptor(argumentsValue.connectionFile, {
      format_version: 1,
      process_id: process.pid,
      workspace_root: host.workspaceRoot,
      api: {
        base_url: host.api.baseUrl,
        bearer_token: host.api.bearerToken,
      },
      runtime: {
        host: host.runtime.host,
        port: host.runtime.port,
        authorization_token: host.runtime.authorizationToken,
      },
    });
    descriptorWritten = true;
  } catch (error) {
    await host.close();
    throw error;
  }

  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      process_id: process.pid,
      workspace_root: host.workspaceRoot,
      connection_file: argumentsValue.connectionFile,
    })}\n`,
  );

  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    const failures: unknown[] = [];
    try {
      await host.close();
    } catch (error) {
      failures.push(error);
    }
    if (descriptorWritten) {
      try {
        await fs.unlink(argumentsValue.connectionFile);
      } catch (error) {
        if (filesystemCode(error) !== "ENOENT") {
          failures.push(error);
        }
      }
    }
    process.exitCode = failures.length === 0 ? exitCode : 1;
  };

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
}

function parseArguments(source: readonly string[]): ServeArguments {
  if (source.includes("--help")) {
    process.stdout.write(
      "Usage: vistrea-host --workspace <path> [--connection-file <path>] [--host 127.0.0.1|::1] [--runtime-port <port>] [--api-port <port>]\n",
    );
    process.exit(0);
  }

  const values = new Map<string, string>();
  const allowed = new Set([
    "--workspace",
    "--connection-file",
    "--host",
    "--runtime-port",
    "--api-port",
  ]);
  for (let index = 0; index < source.length; index += 2) {
    const name = source[index];
    const value = source[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      values.has(name) ||
      value.startsWith("--")
    ) {
      throw new Error("Host arguments are invalid. Use --help for the supported form.");
    }
    values.set(name, value);
  }

  const workspace = values.get("--workspace");
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("--workspace is required.");
  }
  const host = values.get("--host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("--host must be the literal 127.0.0.1 or ::1 loopback address.");
  }
  const connectionFile = path.resolve(
    values.get("--connection-file") ?? path.join(os.tmpdir(), `vistrea-host-${process.pid}.json`),
  );
  return {
    workspaceRoot: path.resolve(workspace),
    connectionFile,
    host,
    ...optionalPort(values.get("--runtime-port"), "runtimePort"),
    ...optionalPort(values.get("--api-port"), "apiPort"),
  };
}

function optionalPort(
  source: string | undefined,
  key: "runtimePort" | "apiPort",
): Readonly<Partial<Record<"runtimePort" | "apiPort", number>>> {
  if (source === undefined) {
    return {};
  }
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(source)) {
    throw new Error(`--${key === "runtimePort" ? "runtime-port" : "api-port"} is invalid.`);
  }
  const value = Number(source);
  if (value > 65_535) {
    throw new Error(`--${key === "runtimePort" ? "runtime-port" : "api-port"} is invalid.`);
  }
  return { [key]: value };
}

async function writePrivateDescriptor(
  filename: string,
  descriptor: ConnectionDescriptor,
): Promise<void> {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const handle = await fs.open(filename, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    try {
      await fs.unlink(filename);
    } catch {
      // Preserve the descriptor write failure.
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

void main().catch(() => {
  process.stderr.write("Vistrea Host could not start.\n");
  process.exitCode = 1;
});
