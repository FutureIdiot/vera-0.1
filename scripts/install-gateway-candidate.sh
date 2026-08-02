#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "install-gateway-candidate.sh must run as root" >&2
  exit 1
fi

CANDIDATE_DIRECTORY=/var/lib/vera-candidates
CANDIDATE_REPOSITORY=$CANDIDATE_DIRECTORY/repository.git
UPDATE_ENV=/etc/vera/gateway-update.env
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -f "$UPDATE_ENV" ]; then
  echo "Gateway updater environment is missing" >&2
  exit 1
fi

if [ ! -d "$CANDIDATE_REPOSITORY/objects" ] || [ ! -f "$CANDIDATE_REPOSITORY/HEAD" ]; then
  install -d -o root -g root -m 0700 "$CANDIDATE_DIRECTORY"
  install -d -o root -g root -m 0700 "$CANDIDATE_REPOSITORY"
  git init --bare "$CANDIDATE_REPOSITORY"
fi
chown -R root:root "$CANDIDATE_REPOSITORY"
chmod 0700 "$CANDIDATE_DIRECTORY"
chmod 0700 "$CANDIDATE_REPOSITORY"

install -o root -g root -m 0755 "$SCRIPT_DIRECTORY/vera-gateway-candidate" /usr/local/sbin/vera-gateway-candidate

EXPECTED="VERA_UPDATE_CANDIDATE_REPOSITORY=$CANDIDATE_REPOSITORY"
if grep -q '^VERA_UPDATE_CANDIDATE_REPOSITORY=' "$UPDATE_ENV"; then
  if ! grep -qx "$EXPECTED" "$UPDATE_ENV"; then
    echo "Gateway candidate repository configuration conflicts with the fixed path" >&2
    exit 1
  fi
else
  TEMPORARY=$(mktemp /etc/vera/.gateway-update.env.XXXXXX)
  trap 'rm -f "$TEMPORARY"' EXIT HUP INT TERM
  cp --preserve=mode,ownership -- "$UPDATE_ENV" "$TEMPORARY"
  printf '\n%s\n' "$EXPECTED" >> "$TEMPORARY"
  mv -f -- "$TEMPORARY" "$UPDATE_ENV"
  trap - EXIT HUP INT TERM
fi

echo "Gateway candidate source installed"
