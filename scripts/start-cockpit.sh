#!/bin/sh
set -eu

case "$#:$*" in
  0:|1:--no-open) cockpit_runtime=rust ;;
  1:--node) cockpit_runtime=node ;;
  *) printf '%s\n' 'Usage: start-cockpit.sh [--no-open | --node]' >&2; exit 64 ;;
esac

cockpit_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)

if [ "$cockpit_runtime" = node ]; then
  exec "${COCKPIT_NODE_BIN:-node}" "$cockpit_root/server.js" --no-open
fi

: "${HOME:?Cockpit requires HOME to select its existing user data}"
cockpit_data_base=${LOCALAPPDATA:-${APPDATA:-"$HOME/.local/share"}}
cockpit_binary="$cockpit_root/rust-server/target/release/cockpit-server"
if [ ! -x "$cockpit_binary" ]; then
  printf '%s\n' "Cockpit Rust release executable is missing or not executable: $cockpit_binary" \
    'Build it with cargo build --release --manifest-path rust-server/Cargo.toml, or explicitly use --node to roll back.' >&2
  exit 127
fi

exec "$cockpit_binary" --managed --root "$cockpit_root" \
  --data-dir "${cockpit_data_base%/}/cockpit" --home-dir "$HOME"
