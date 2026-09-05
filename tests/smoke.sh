#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = --fake ]; then
  mode=$2
  stty -echo -icanon -isig
  [ "$mode" != before-render ] || exit 7
  printf 'main-session-test\n'
  read -r command
  [ "$command" = /model ]
  [ "$mode" != before-model ] || exit 7
  printf 'Select model\n'
  dd bs=1 count=2 status=none >/dev/null
  [ "$mode" != after-model ] || exit 7
  exit 0
fi

expect "$1" bash "$0" --fake success
for mode in before-render before-model after-model; do
  if expect "$1" bash "$0" --fake "$mode"; then
    echo "Smoke test accepted a child failure: $mode" >&2
    exit 1
  fi
done
