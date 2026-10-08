# Install HeyAnon

Use this guide when the user asks to connect HeyAnon. Complete setup and report
the result. Run as the current user without sudo and respect host permissions.

## Install

Requires Node.js 22+, npm, curl and tar. Replace `CLIENT` with the current
client: `codex`, `claude`, `hermes` or `openclaw`.

```bash
curl -fsSL https://raw.githubusercontent.com/RealWagmi/heyanon-connect/main/install.sh | bash -s -- install CLIENT --agent
```

The script downloads the installer into a temporary directory, runs it and
removes the download; nothing else needs to be cloned or kept. Run it as a
normal foreground command.

**Codex/Claude:** the command prints a one-time link and exits right away;
a detached helper keeps the page open for 15 minutes. Give the user the link
exactly as printed. They get their key at https://heyanon.ai/, paste it on the
page, and the page itself checks the key with one read-only `wallet_list`
call, saves it in the client config and shows the result ("Connected" or an
error). Nothing is left for you to wait on. When the user confirms the page
showed "Connected", run the `check` command below. If the link expired, run
the install command again. If the user cannot open the link (this machine is
remote or a container), ask them to run the same command without `--agent` in
their own terminal, where it asks for the key directly; never ask for the key
in chat. An existing `HEYANON_API_KEY` environment variable is used instead of
the page. Under Codex, run the command with network and home-directory access,
outside the sandbox.

**Hermes/OpenClaw:** run on the agent's host under its service user and active
profile, respecting `HERMES_HOME` or OpenClaw's profile, state and config
environment settings. Setup saves a literal `${HEYANON_API_KEY}` reference and
never opens a page. The user supplies the secret afterwards through the
framework: Hermes profile secret settings or `.env`; OpenClaw Gateway
service/container environment or profile `.env` (not
`skills.entries.heyanon.apiKey`). Setup can finish before the secret exists;
report that HeyAnon tools need the secret.

Never request a key in chat, read it into context, print it or put it in
command arguments; the HeyAnon tools take no key argument.

After setup, read-only HeyAnon tools run without a prompt, while `ask_anon`,
`abort`, `clear` and the delete tools keep asking for confirmation (Codex: via
the server's tool annotations; Claude: via installed `ask` rules). Existing
restrictions, Claude ask/deny rules and managed policies stay in effect; do not
change global permissions.

## Verify and finish

Check the exit status and the printed summary: config and skill paths, MCP
discovery and, for Codex/Claude, "API key accepted". To check again later:

```bash
curl -fsSL https://raw.githubusercontent.com/RealWagmi/heyanon-connect/main/install.sh | bash -s -- check CLIENT
```

No transaction, login, wallet creation or task submission is needed. On
failure, report the actual error; do not overwrite custom skills or unrelated
connections.

Ask the user to restart or reload the client: Codex and Claude Code restart,
Hermes `/reload-mcp`, OpenClaw restarts its Gateway after the secret is set.
Report the installed connection, skill and tool permissions. Optional Claude
channel and Codex App Server delivery is described in the skill's
`references/delivery.md`; read it only when requested and do not enable
channels, launch an App Server or register webhooks automatically.
