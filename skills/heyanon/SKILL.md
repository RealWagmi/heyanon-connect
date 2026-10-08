---
name: heyanon
description: Use HeyAnon MCP for blockchain and crypto operations, wallet/portfolio queries, DeFi, CEX orders, protocol research and task status, even when HeyAnon is not named. Supports requests in any language. Exclude standalone smart-contract coding/auditing and explanations needing no live data.
---

# HeyAnon

Use the installed `heyanon` tools and their schemas. Keys come from
https://heyanon.ai/ and stay in client configuration or framework secrets.
Never read a key into model context, chat or tool arguments; the tools take
no key argument. Authentication problems belong in those settings.

## Tools and requests

- Use `wallet_list` for addresses and the `portfolio_*` readers for account data.
- Use `projects` when protocol/network support is unclear; reuse its results.
- Use `ask_gemma({text})` for crypto research. It returns the answer directly
  and has its own conversation. `clear` resets Anon, not Gemma.
- Use `ask_anon({text, wallets})` for requested actions, automations or questions
  needing the Anon agent. It can execute transactions and returns a task ID.
  Optional attachments use `files: [{url, mimetype}]`.

Before `ask_anon`, select addresses from `wallet_list`: at least one, at most
one per type (EVM, Solana, TON). Use the user's named or previously chosen
wallet; if several fit and none was chosen, ask. Reuse addresses for follow-ups.

Send the complete request in `text`, preserving amounts, tokens, networks,
recipients, protocols, constraints and relevant context. Keep linked steps
(swap then deposit the proceeds) together. Resolve missing facts through
readers/context; ask for essential unresolved choices and retain choices the
user delegates. Do not substitute an explicitly requested provider or chain.
Tool approval does not authorize actions beyond the user's request.

Anon shares one conversation: wait for each request to finish before sending
another, including from subagents. Do not clear its context between steps.

## Results

Read `background_task({id})` using the returned ID: `pending` means wait;
`completed` means read `result`; `failed` means report the result/logs.
Completion can contain a clarification or partial failure. Report the actual
answer and returned transaction links; an ID alone proves no execution.

If submission times out or returns an invalid ID, inspect `background_task_list`
before retrying. Never repeat a transaction request just to obtain its result.
`background_task_delete({id})` deletes a record; it does not establish cancellation.
Scheduled automations use `scheduled_task_list` and `scheduled_task_get`.

## Waiting and subagents

Run the installed helper:

```bash
node /absolute/path/to/this/skill/scripts/wait.mjs TASK_ID
```

It reads configured credentials, polls only `background_task` every five
seconds, and prints one JSON result. `result` is the answer; `task` includes
logs. The default timeout is one hour. It needs outbound HTTPS: in a Codex
sandbox without network access run it with escalation or use the connected
`background_task` tool instead.

For a long wait, give a background worker/subagent the existing ID and helper
path. It returns the result without submitting another operation or doing a
second model-driven polling loop. Existing IDs can be watched concurrently;
Anon submissions remain sequential.

On Hermes/OpenClaw, the worker needs the same profile and injected
`HEYANON_API_KEY`. If unavailable, or tool filters apply, use the host's connected
`background_task` tool. Do not copy secrets into worker instructions or bypass
host permissions. Telegram delivery uses the host's normal worker completion.

A watcher timeout/error or stopping it does not cancel the backend task; resume
reading the same ID. Do not use account-wide `abort` or `isProcessing` for one
concurrent task. For opted-in Claude channels or an application-owned Codex
App Server session, read [client delivery](references/delivery.md).
