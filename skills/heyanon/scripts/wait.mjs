#!/usr/bin/env node
import { waitCommand } from '../runtime/wait-command.mjs';

try { await waitCommand(process.argv.slice(2)); }
catch (error) { console.error(`HeyAnon waiter: ${error.message}`); process.exitCode = 1; }
