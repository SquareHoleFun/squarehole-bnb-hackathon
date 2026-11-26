# Alpha backup permissions regression

`parent-backup.mjs.txt` is the full, unchanged `infra/server/services/alpha/backup.mjs` from
server parent `b8a1387b0`. SHA-256: `6bd081bf1b9a00748c7f257bffb1791b7cc88cab8bb31a040bfbc63656d3cac2`.
It is imported as data by the Docker control. The control calls its exported snapshot and checks the caught
EPERM, copyfile syscall and queue path. This exposes the error that the old CLI hid.

`check.mjs plan` reads only repository source. Installer directory commands supply owners and modes.
The queue's named writer ACL changes its stat mask to 2770. The fixture reproduces that mask; it does not test
API writer ACL isolation. Backup runs as the directory owner, UID 0, so that named ACL does not affect its read.
Compose supplies the startup users. The API's source supplies its permanent UID/GID drop and read group.
The sender's nocopy volume and startup fchmod supply its root-owned 0700 directory.

The image check creates four unique volumes. API and sender fixture processes write their own files.
The API writer is killed after committing a WAL row; the fixture removes only its own SHM to force read-side
creation and ownership repair. Withholding starts empty. The parent refusal leaves the retired marker.
Both new backups must succeed, including with that marker present. A third state follows: the service user opens
the database and closes it cleanly (no -wal or -shm left, the usual nightly state), a third backup runs, and a
container with the API's identity then opens the source database read-write, inserts a row, reads it back and checks
that any sidecar present belongs to the service user with the database's mode. File modes in the fixture are read
from the services' source with pinned patterns (`sourcePlan`, `modes`); a pattern that stops matching fails the plan. Verification runs under the same flags,
checks CHOWN-only capabilities and the read-only sender mount, every manifest hash and file mode, a restored
row and integrity check, and source WAL/SHM ownership. No installed state, settings or network is used.

All fixture containers use --rm and record a cidfile. EXIT checks those IDs for an interrupted container,
then removes only the volume names recorded by this invocation. Existing volumes are refused before create.
Logs and IDs stay in the printed .cache/tmp directory as evidence. A killed host or SIGKILL can interrupt cleanup.
