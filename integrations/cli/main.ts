#!/usr/bin/env node

import { runVistreaCli } from "./cli.js";

process.exitCode = await runVistreaCli(process.argv.slice(2));
