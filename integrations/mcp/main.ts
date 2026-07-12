#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createHostLocalApiClientFromEnvironment } from "../shared/index.js";
import { createVistreaMcpServer } from "./server.js";

try {
  const client = createHostLocalApiClientFromEnvironment(process.env);
  const server = createVistreaMcpServer(client);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write("Vistrea MCP server failed to start.\n");
  process.exitCode = 10;
}
