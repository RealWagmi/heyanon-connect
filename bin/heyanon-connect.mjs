#!/usr/bin/env node
import { run } from '../src/cli.mjs';

try {
  await run(process.argv.slice(2));
} catch (error) {
  // Never print raw responses, config content, or exception stacks containing credentials.
  console.error(`HeyAnon: ${error instanceof Error ? error.message : 'Setup failed.'}`);
  process.exitCode = 1;
}
