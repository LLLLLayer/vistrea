import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { createRepositoryProtocolValidator } from "../../data/memory/index.js";
import {
  startLocalHost,
  type HostAutomationConfig,
  type HostLocalApiBindAddress,
} from "./index.js";

/** A caller mistake whose message is static and safe to print. */
class UsageError extends Error {}

interface ServeArguments {
  readonly workspaceRoot: string;
  readonly connectionFile: string;
  readonly host: HostLocalApiBindAddress;
  readonly runtimePort?: number;
  readonly apiPort?: number;
  readonly runtimeTls?: {
    readonly host: string;
    readonly certificatePath: string;
    readonly privateKeyPath: string;
  };
  readonly automation?: HostAutomationConfig;
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
    readonly host: string;
    readonly port: number;
    readonly authorization_token: string;
    readonly transport: "loopback" | "tls";
    readonly certificate_sha256?: string;
  };
}

async function main(): Promise<void> {
  const argumentsValue = parseArguments(process.argv.slice(2));
  const validator = await createRepositoryProtocolValidator({ repositoryRoot: process.cwd() });
  const runtimeTls =
    argumentsValue.runtimeTls === undefined
      ? undefined
      : {
          host: argumentsValue.runtimeTls.host,
          certificate: await fs.readFile(argumentsValue.runtimeTls.certificatePath),
          privateKey: await fs.readFile(argumentsValue.runtimeTls.privateKeyPath),
        };
  const host = await startLocalHost({
    workspaceRoot: argumentsValue.workspaceRoot,
    validator,
    host: argumentsValue.host,
    ...(argumentsValue.runtimePort === undefined
      ? {}
      : { runtimePort: argumentsValue.runtimePort }),
    ...(argumentsValue.apiPort === undefined ? {} : { apiPort: argumentsValue.apiPort }),
    ...(runtimeTls === undefined ? {} : { runtimeTls }),
    ...(argumentsValue.automation === undefined ? {} : { automation: argumentsValue.automation }),
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
        transport: host.runtime.transport,
        ...(host.runtime.transport === "tls"
          ? { certificate_sha256: host.runtime.certificateSha256 }
          : {}),
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
      "Usage: vistrea-host --workspace <path> [--connection-file <path>] [--host 127.0.0.1|::1] " +
        "[--runtime-port <port>] [--runtime-host <ip> --runtime-tls-cert <pem> --runtime-tls-key <pem>] [--api-port <port>] " +
        "[--automation adb --automation-serial <serial> [--adb-path <path>] | --automation wda --wda-url <loopback-url>]\n",
    );
    process.exit(0);
  }

  const values = new Map<string, string>();
  const allowed = new Set([
    "--workspace",
    "--connection-file",
    "--host",
    "--runtime-port",
    "--runtime-host",
    "--runtime-tls-cert",
    "--runtime-tls-key",
    "--api-port",
    "--automation",
    "--automation-serial",
    "--adb-path",
    "--wda-url",
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
      throw new UsageError("Host arguments are invalid. Use --help for the supported form.");
    }
    values.set(name, value);
  }

  const workspace = values.get("--workspace");
  if (workspace === undefined || workspace.length === 0) {
    throw new UsageError("--workspace is required.");
  }
  const host = values.get("--host") ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new UsageError("--host must be the literal 127.0.0.1 or ::1 loopback address.");
  }
  const connectionFile = path.resolve(
    values.get("--connection-file") ?? path.join(os.tmpdir(), `vistrea-host-${process.pid}.json`),
  );
  const runtimeTls = runtimeTlsArguments(values);
  const automation = automationConfig(values);
  return {
    workspaceRoot: path.resolve(workspace),
    connectionFile,
    host,
    ...optionalPort(values.get("--runtime-port"), "runtimePort"),
    ...optionalPort(values.get("--api-port"), "apiPort"),
    ...(runtimeTls === undefined ? {} : { runtimeTls }),
    ...(automation === undefined ? {} : { automation }),
  };
}

function runtimeTlsArguments(
  values: ReadonlyMap<string, string>,
): ServeArguments["runtimeTls"] {
  const runtimeHost = values.get("--runtime-host");
  const certificate = values.get("--runtime-tls-cert");
  const privateKey = values.get("--runtime-tls-key");
  if (runtimeHost === undefined && certificate === undefined && privateKey === undefined) {
    return undefined;
  }
  if (
    runtimeHost === undefined ||
    certificate === undefined ||
    privateKey === undefined ||
    net.isIP(runtimeHost) === 0 ||
    runtimeHost === "0.0.0.0" ||
    runtimeHost === "::" ||
    !path.isAbsolute(certificate) ||
    !path.isAbsolute(privateKey)
  ) {
    throw new UsageError(
      "TLS Runtime access requires one explicit IP plus absolute certificate and key paths.",
    );
  }
  return {
    host: runtimeHost,
    certificatePath: certificate,
    privateKeyPath: privateKey,
  };
}

function automationConfig(values: Map<string, string>): HostAutomationConfig | undefined {
  const kind = values.get("--automation");
  if (kind === undefined) {
    if (values.has("--automation-serial") || values.has("--adb-path") || values.has("--wda-url")) {
      throw new UsageError("Automation flags require --automation adb|wda.");
    }
    return undefined;
  }
  if (kind === "adb") {
    const serial = values.get("--automation-serial");
    if (serial === undefined || serial.length === 0 || values.has("--wda-url")) {
      throw new UsageError("--automation adb requires --automation-serial and forbids --wda-url.");
    }
    const adbPath =
      values.get("--adb-path") ??
      path.join(
        process.env["ANDROID_HOME"] ?? path.join(os.homedir(), "Library/Android/sdk"),
        "platform-tools/adb",
      );
    return { kind: "adb", adbPath, serial };
  }
  if (kind === "wda") {
    const baseUrl = values.get("--wda-url");
    if (baseUrl === undefined || values.has("--automation-serial") || values.has("--adb-path")) {
      throw new UsageError("--automation wda requires --wda-url and forbids the adb flags.");
    }
    return { kind: "wda", baseUrl };
  }
  throw new UsageError("--automation must be adb or wda.");
}

function optionalPort(
  source: string | undefined,
  key: "runtimePort" | "apiPort",
): Readonly<Partial<Record<"runtimePort" | "apiPort", number>>> {
  if (source === undefined) {
    return {};
  }
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(source)) {
    throw new UsageError(`--${key === "runtimePort" ? "runtime-port" : "api-port"} is invalid.`);
  }
  const value = Number(source);
  if (value > 65_535) {
    throw new UsageError(`--${key === "runtimePort" ? "runtime-port" : "api-port"} is invalid.`);
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

void main().catch((error: unknown) => {
  // Usage errors carry static messages; everything else stays generic so no
  // failure path can echo workspace contents or credentials.
  process.stderr.write(
    error instanceof UsageError ? `${error.message}\n` : "Vistrea Host could not start.\n",
  );
  process.exitCode = 1;
});
