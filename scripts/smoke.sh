#!/usr/bin/env bash
# Smoke-test a built idj image: boot it and make real requests.
#
#   scripts/smoke.sh <image> [expected-sha]
#
# Build + typecheck passed for be9bde7, which then answered 500 to every
# request in production for three days (2026-11-07 to 11-10). Only running it
# shows that. CI runs this before publishing, because pushing master deploys
# (ops Renovate follows :latest).
set -euo pipefail

image="${1:?usage: scripts/smoke.sh <image> [expected-sha]}"
want_sha="${2:-}"
name="idj-smoke-$$"
port="${SMOKE_PORT:-3999}"
base="http://localhost:${port}"
body="$(mktemp)"
wav="$(mktemp)"

cleanup() {
	status=$?
	if [ "$status" -ne 0 ]; then
		echo "--- container log (last 60 lines)"
		docker logs "$name" 2>&1 | tail -60 || true
	fi
	docker rm -f "$name" >/dev/null 2>&1 || true
	rm -f "$body" "$wav"
	exit "$status"
}
trap cleanup EXIT

docker run -d --name "$name" -p "${port}:3000" \
	-e DATABASE_URL=file:/tmp/idj.db -e SESSION_SECRET=smoke "$image" >/dev/null

for _ in $(seq 1 60); do
	curl -sf "${base}/api/version" >/dev/null && break
	sleep 1
done

# check <name> <expected status> <curl args...>
check() {
	local what="$1" want="$2"
	shift 2
	local got
	got="$(curl -s -o "$body" -w '%{http_code}' "$@")"
	if [ "$got" != "$want" ]; then
		echo "FAIL ${what}: HTTP ${got}, wanted ${want}: $(head -c 300 "$body")"
		exit 1
	fi
	echo "ok   ${what} (${got})"
}

check 'version' 200 "${base}/api/version"
if [ -n "$want_sha" ] && ! grep -q "$want_sha" "$body"; then
	echo "FAIL version: $(cat "$body"), wanted ${want_sha}"
	exit 1
fi
check 'inbox page redirects to login' 307 "${base}/"
check 'passkey options' 200 -X POST -H 'content-type: application/json' \
	-d '{"displayName":"smoke"}' "${base}/api/auth/register/options"
check 'signed shortcut download' 200 "${base}/shortcut"
if [ "$(head -c 4 "$body")" != "AEA1" ]; then
	echo "FAIL signed shortcut download: not an Apple-signed file"
	exit 1
fi
check 'capture without token' 401 -X POST --data x "${base}/api/capture"

token="$(docker exec "$name" bun run scripts/mint-token.ts capture smoke | grep -oE 'idj_capture_[A-Za-z0-9_-]+')"
check 'text capture' 201 -X POST -H "Authorization: Bearer ${token}" \
	-H 'Content-Type: text/plain' --data 'todo: smoke test #ci' "${base}/api/capture"

# One second of 8 kHz 16-bit silence: a 44-byte WAV header, then zeros.
{
	printf 'RIFF'
	printf '\x24\x3e\x00\x00' # 36 + 16000
	printf 'WAVEfmt '
	printf '\x10\x00\x00\x00\x01\x00\x01\x00' # fmt size 16, PCM, mono
	printf '\x40\x1f\x00\x00\x80\x3e\x00\x00' # 8000 Hz, 16000 bytes/s
	printf '\x02\x00\x10\x00'                 # block align 2, 16 bits
	printf 'data'
	printf '\x80\x3e\x00\x00' # 16000 bytes
	head -c 16000 /dev/zero
} >"$wav"
check 'voice capture' 201 -X POST -H "Authorization: Bearer ${token}" \
	-H 'Content-Type: audio/wav' --data-binary "@${wav}" "${base}/api/capture"

echo "smoke test passed"
