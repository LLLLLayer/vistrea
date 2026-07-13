#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createHostLocalApiClientFromEnvironment } from "../shared/index.js";
import { createVistreaMcpServer, parseMcpToolsets, type VistreaMcpToolset } from "./server.js";

// Toolset names are configuration, not secrets, so this failure may explain
// itself; everything after the client exists stays generic to keep the token
// out of stderr.
let toolsets: VistreaMcpToolset[] | undefined;
try {
  toolsets = parseMcpToolsets(process.env["VISTREA_MCP_TOOLSETS"]);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Invalid VISTREA_MCP_TOOLSETS."}\n`,
  );
  process.exit(11);
}

try {
  const client = createHostLocalApiClientFromEnvironment(process.env);
  const server = createVistreaMcpServer(client, toolsets === undefined ? {} : { toolsets });
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write("Vistrea MCP server failed to start.\n");
  process.exitCode = 10;
}
