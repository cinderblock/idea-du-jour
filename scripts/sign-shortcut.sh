#!/usr/bin/env bash
# Sign the generated shortcut on the Mac mini and put the result in public/.
#
#   bun run shortcut:sign
#
# iOS imports only Apple-signed shortcut files, and `shortcuts sign` needs a
# Mac signed into iCloud. The mini (ssh alias `mini`) is that Mac; see ops
# plans/shortcut-signing-mini.md. The file carries no secret (the token is an
# import question), so signing in "anyone" mode and serving it publicly is fine.
#
# Files travel over plain ssh pipes rather than scp: Git Bash's scp driving
# Windows' OpenSSH hangs.
set -euo pipefail

in="${1:-build/record-to-idj.unsigned.shortcut}"
out="${2:-public/record-to-idj.shortcut}"
host="${SIGN_HOST:-mini}"
tmp="/tmp/idj-shortcut-$$"

[ -f "$in" ] || { echo "no $in: run bun run shortcut:build first" >&2; exit 1; }

ssh -o BatchMode=yes "$host" "cat > ${tmp}.in.shortcut" <"$in"
# plutil catches a malformed plist here rather than on the phone.
ssh -o BatchMode=yes "$host" "plutil -lint ${tmp}.in.shortcut && shortcuts sign --mode anyone -i ${tmp}.in.shortcut -o ${tmp}.out.shortcut"
ssh -o BatchMode=yes "$host" "cat ${tmp}.out.shortcut" >"$out"
ssh -o BatchMode=yes "$host" "rm -f ${tmp}.in.shortcut ${tmp}.out.shortcut"

magic="$(head -c 4 "$out")"
if [ "$magic" != "AEA1" ]; then
	echo "signed file doesn't start with AEA1 (got: $magic)" >&2
	exit 1
fi
echo "signed: $out ($(wc -c <"$out") bytes)"
