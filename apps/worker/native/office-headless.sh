#!/bin/sh
# Headless Office without the desktop launcher, which hard-codes /tmp IPC.
# Exit 81 requests a restart after first-profile initialization. Bound it to
# three starts in the same private, network-denied document execution.
attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  /usr/lib/libreoffice/program/soffice.bin "$@"
  status=$?
  if [ "$status" -ne 81 ]; then
    exit "$status"
  fi
done
exit 81
