# Shared by the installed wrapper and the real image check. Mount sources differ; permissions do not.
# shellcheck shell=bash
alpha_backup_flags=(--rm --network none --read-only --user 0:2101 --group-add 2103 --cap-drop ALL --cap-add CHOWN
  --security-opt no-new-privileges --tmpfs /tmp:rw,nosuid,nodev,size=16m --entrypoint node)
