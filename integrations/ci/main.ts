#!/usr/bin/env node

import { runVistreaCiGate } from "./ci.js";

process.exitCode = await runVistreaCiGate(process.argv.slice(2));
