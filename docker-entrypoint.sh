#!/bin/sh
set -e
dir="${BOT_TMP_DIR:-/tmp/gupt-bots}"
mkdir -p "$dir"
if [ "$(id -u)" = 0 ]; then
  chown -R node:node "$dir"
  exec runuser -u node -- "$@"
fi
exec "$@"
