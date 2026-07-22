#!/usr/bin/env node

import { runSetup } from "../src/core/setup-cli.js";

process.exitCode = await runSetup();
