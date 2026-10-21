#!/usr/bin/env bash
# install.sh setup|serve
#   setup: install the unit with BETTER_AUTH_URL=http://localhost:4400 for first-run owner setup over loopback
#   serve: switch BETTER_AUTH_URL to https://exec.gneiss.run once the owner exists
# Image: executor-selfhost 2.0.0-beta.25 (revision 92f85f4). Back up the executor-v2-data volume before any image bump.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
unit=~/.config/systemd/user/executor.service
mode=${1:?setup|serve}
mkdir -p ~/.config/systemd/user
case $mode in
  setup) sed 's|^Environment=BETTER_AUTH_URL=.*|Environment=BETTER_AUTH_URL=http://localhost:4400|' "$here/executor.service" > "$unit" ;;
  serve) cp "$here/executor.service" "$unit" ;;
  *) echo "setup|serve" >&2; exit 2 ;;
esac
systemctl --user daemon-reload
systemctl --user enable executor.service >/dev/null
systemctl --user restart executor.service
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null http://127.0.0.1:4400/health 2>/dev/null && { echo "executor healthy ($mode)"; exit 0; }
  sleep 1
done
echo "executor did not become healthy; journalctl --user -u executor" >&2
exit 1
