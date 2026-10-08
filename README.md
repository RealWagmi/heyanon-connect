# HeyAnon Connect

Connect Codex, Claude Code, Hermes or OpenClaw to the HeyAnon MCP server and
install the HeyAnon skill with its background-task helper. Get your API key at
https://heyanon.ai/.

## Quick start

Requires Node.js 22+, npm, curl and tar. Nothing is installed globally and no
checkout is kept: the script downloads the installer into a temporary
directory, runs it and deletes it. Only the client config, Claude's permission
rules, the skill and a `.heyanon-connect.bak` backup of the previous config stay.

```bash
curl -fsSL https://raw.githubusercontent.com/RealWagmi/heyanon-connect/main/install.sh | bash -s -- install claude
```

Replace `claude` with `codex`, `hermes` or `openclaw`, then restart the client.

- Run it yourself in a terminal: it asks for the key and does not show it on
  screen.
- Run by an AI agent, or with `--agent`: it prints a link. Open it, paste your
  key, done. The link works for 15 minutes; if it expired, run the command
  again. If the link does not open, run the command yourself in a terminal.
- An existing `HEYANON_API_KEY` environment variable is used directly.
- Hermes/OpenClaw never ask for a key; see below.

The same command with `check` or `remove` checks or removes the connection:

```bash
curl -fsSL https://raw.githubusercontent.com/RealWagmi/heyanon-connect/main/install.sh | bash -s -- check claude
```

## Install through your agent

> Read https://github.com/RealWagmi/heyanon-connect/blob/main/INSTALL.md and
> install HeyAnon MCP and its skill for this client. Never ask for my key in chat.

The agent runs the command above with `--agent`, shows you the local key page
and waits while you enter the key there. For Hermes or OpenClaw add: "Use the
HEYANON_API_KEY environment reference; I will configure the secret in the
framework settings myself."

## What gets installed

| Client | MCP configuration | Skill and helpers |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | `~/.agents/skills/heyanon/` |
| Claude Code | `~/.claude.json` | `~/.claude/skills/heyanon/` |
| Hermes | `~/.hermes/config.yaml` | `~/.hermes/skills/heyanon/` |
| OpenClaw | `~/.openclaw/openclaw.json` | `~/.openclaw/skills/heyanon/` |

Codex respects `CODEX_HOME`; Hermes respects `HERMES_HOME`. OpenClaw respects
`OPENCLAW_HOME`, `OPENCLAW_PROFILE`, `OPENCLAW_STATE_DIR` and
`OPENCLAW_CONFIG_PATH`. Run under the intended user's profile.

**Keys.** Codex and Claude Code store the key in their own config as the
`X-API-Key` header. Written configs have mode `0600`; the previous version is
saved next to them as `<config>.heyanon-connect.bak`, so keep both out of
version control. Before writing anything, setup checks the key with one
read-only `wallet_list` call: a rejected key aborts the install, a temporary
server error is reported and the install continues. Hermes and OpenClaw store
only the reference
`${HEYANON_API_KEY}`; supply the secret through the framework afterwards:

- **Hermes:** the active profile's secret settings or `.env`, normally
  `~/.hermes/.env`, then `/reload-mcp` or restart Hermes.
- **OpenClaw:** the Gateway service/container environment or the active
  profile's `.env`, then restart the Gateway. A skill-only `apiKey` does not
  authenticate the MCP connection.

Setup never retrieves keys or creates accounts, and it can finish before a
framework secret exists. Do not send keys through chat or Telegram.

**Permissions.** Codex gets `default_tools_approval_mode = "approve"` for
`heyanon`; Claude gets `mcp__heyanon__*` in `permissions.allow`. Actions keep
asking for confirmation: `ask_anon`, `abort`, `clear`, `background_task_delete`
and `scheduled_task_delete` get `approval_mode = "prompt"` in Codex and an
`ask` rule in Claude. Existing explicit settings, deny rules and managed
policies are preserved. Claude also gets a local `heyanon_events` MCP entry for
optional channel delivery.

The skill bundles its runtime and config parsers, so it works after the
temporary download is gone. Helpers read the current key from the client config
or the framework environment; there is no second copy of the key.

## Using the skill

The skill is discoverable for blockchain/crypto operations, balances,
portfolios, DeFi/CEX and protocol research without naming HeyAnon.

- `wallet_list` and `portfolio_*`: direct account readers.
- `projects`: supported protocols and networks.
- `ask_anon({text, wallets})`: actions and automations; returns a background task ID.
- `ask_gemma({text})`: research; returns its answer directly.

Anon requires addresses from `wallet_list`, at least one and at most one per
wallet type. Keep related steps in one request and send requests sequentially:
Anon shares one conversation. Gemma has a separate conversation.

## Background tasks

For an existing task, a background worker or subagent runs the helper that the
installed skill names, for example:

```bash
node ~/.claude/skills/heyanon/scripts/wait.mjs TASK_ID
```

It calls `background_task({id})` every five seconds and prints one JSON result:
`result` contains the answer; `task` contains the record and logs. The default
timeout is one hour; `--timeout-seconds` allows up to 24 hours. Temporary
server errors are retried up to three times; submissions are never retried.
The helper needs outbound HTTPS; a Codex sandbox without network access must
run it with escalation or use the connected `background_task` tool instead.

Give a waiting worker the existing ID, not a new action request. Stopping a
watcher does not cancel the backend operation. Hermes/OpenClaw workers need the
same profile and injected secret; otherwise use the host's connected MCP
reader. Optional Claude channel and Codex App Server delivery is described in
the skill's `references/delivery.md`.

## Checks, updates and removal

`check` performs MCP discovery and, when a key is available, verifies it with
`wallet_list`. After a restart, confirm the client's MCP connections and skill
list; for a framework also check from its active profile with
`hermes mcp test heyanon` or `openclaw mcp doctor heyanon --probe`.

Rerun `install` to update the connection, skill and helpers, or to replace a
local key. Rotate framework keys in the framework's secret settings. Setup
refuses conflicting connections, linked config files and manually edited skills
instead of overwriting them; move an edited skill aside first. Formatting of
Codex and OpenClaw configs is normalized and their comments may be lost.

`remove` deletes the HeyAnon entry, the owned channel and the installed skill,
and removes the Claude rules the installer added. Keys are not revoked and the
`.heyanon-connect.bak` backups remain; delete them if they must not keep the key.

## Development

```bash
git clone https://github.com/RealWagmi/heyanon-connect.git
cd heyanon-connect
npm ci --ignore-scripts
npm start -- install codex
npm test
```

The MCP address is the `ENDPOINT` constant in `src/config.mjs`. Tests use
isolated profiles and mocked servers; there is no build step.
