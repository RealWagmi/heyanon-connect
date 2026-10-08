#!/usr/bin/env node
import { serveChannel } from '../runtime/channel.mjs';

const channel = serveChannel();
process.once('SIGINT', () => channel.close());
process.once('SIGTERM', () => channel.close());
