#!/usr/bin/env node

import { runGatewayUpdate } from "./gateway-update-runtime.js";

try {
  await runGatewayUpdate(process.env);
} catch {
  process.exitCode = 1;
}
