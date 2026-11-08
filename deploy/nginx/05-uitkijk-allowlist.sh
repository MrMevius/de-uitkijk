#!/bin/sh
# Writes the client allowlist used by default.conf from UITKIJK_ALLOW_FROM
# (space-separated addresses or CIDRs). Empty means every client is allowed.
set -eu
out=/etc/nginx/uitkijk-allow.geo
: > "$out"
if [ -z "${UITKIJK_ALLOW_FROM:-}" ]; then
    echo "0.0.0.0/0 1;" >> "$out"
    echo "::/0 1;" >> "$out"
    exit 0
fi
for entry in $UITKIJK_ALLOW_FROM; do
    case "$entry" in
        *[!0-9a-fA-F.:/]*) echo "uitkijk: invalid UITKIJK_ALLOW_FROM entry: $entry" >&2; exit 1 ;;
    esac
    echo "$entry 1;" >> "$out"
done
echo "uitkijk: dashboard restricted to: $UITKIJK_ALLOW_FROM"
