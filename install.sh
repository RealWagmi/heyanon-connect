#!/usr/bin/env bash
set -euo pipefail
connect_workdir=''

# Bootstrap for the public RealWagmi/heyanon-connect repository. No sudo, global
# npm install, shell-profile changes, or local MCP proxy are needed.
# Usage: curl -fsSL https://raw.githubusercontent.com/RealWagmi/heyanon-connect/main/install.sh \
#          | bash -s -- [install|check|remove] [codex|claude|hermes|openclaw] [--agent]
main() {
  for dependency in node npm curl tar; do
    command -v "$dependency" >/dev/null 2>&1 || { printf 'Missing dependency: %s\n' "$dependency" >&2; return 1; }
  done
  if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf 'Node.js 22 or later is required.\n' >&2
    return 1
  fi
  connect_workdir="$(mktemp -d)"
  trap 'rm -rf -- "$connect_workdir"' EXIT
  printf 'Downloading HeyAnon Connect…\n'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    https://github.com/RealWagmi/heyanon-connect/archive/refs/heads/main.tar.gz \
    -o "$connect_workdir/source.tar.gz"
  mkdir "$connect_workdir/app"
  tar -xzf "$connect_workdir/source.tar.gz" --strip-components=1 -C "$connect_workdir/app"
  npm ci --prefix "$connect_workdir/app" --ignore-scripts --no-audit --no-fund </dev/null
  if ( : </dev/tty ) 2>/dev/null; then
    node "$connect_workdir/app/bin/heyanon-connect.mjs" "$@" </dev/tty
  else
    node "$connect_workdir/app/bin/heyanon-connect.mjs" "$@" </dev/null
  fi
}

main "$@"
