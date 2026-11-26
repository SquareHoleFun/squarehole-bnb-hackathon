# Box 0 IPFS node

SH-MF21-hosting supplies a Linux droplet configuration for readiness step 21. Follow
[the installation runbook](../../docs/runbooks/ipfs-node.md) and
[the Arweave copy plan](../../docs/design/arweave-copies.md). Installation, public ingress,
Pinata signup/payment, reveal scheduling and site integration are separate operations.

The tests live here because this ticket owns no separate test file. They validate the actual
Compose model with Compose itself, exercise the configuration merger against a fake repository,
and run the startup and health commands with a fake IPFS executable. They make no network calls,
start no listeners and require only Python 3 and Docker Compose. Scratch stays under `.cache/`.
They do not substitute for running Kubo and Caddy's native validators at installation.

From the repository root:

```sh
python3 -c 'from pathlib import Path; exec(compile(Path("infra/ipfs/README.md").read_text().split("```python test\n")[1].split("\n```")[0], "ipfs-config-tests", "exec"))'
```

```python test
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
import uuid

ROOT = Path("infra/ipfs")
SCRATCH = Path(".cache/mf21-tests") / uuid.uuid4().hex
SCRATCH.mkdir(parents=True)
(SCRATCH / "docker").mkdir()
(SCRATCH / "empty.env").write_text("")
ENV = {**os.environ, "DOCKER_CONFIG": str((SCRATCH / "docker").resolve()),
       "SH_IPFS_VOLUME": "squarehole-ipfs-test"}
COMPOSE = (["docker-compose"] if shutil.which("docker-compose") else ["docker", "compose"])

def model():
    result = subprocess.run(COMPOSE + ["--env-file", str(SCRATCH / "empty.env"),
        "-f", str(ROOT / "docker-compose.yml"), "config", "--format", "json",
        "--no-path-resolution"], env=ENV, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError("Compose configuration missing or invalid")
    return json.loads(result.stdout)

class HostingConfigTests(unittest.TestCase):
    def test_owned_configuration_exists(self):
        for name in ("docker-compose.yml", "kubo-config.json", "Caddyfile"):
            self.assertTrue((ROOT / name).is_file(), name + " is missing")

    def test_network_and_lifecycle(self):
        m = model()
        s = m["services"]
        self.assertEqual(set(s), {"init", "configure", "kubo", "gateway"})
        for name in ("init", "configure"):
            self.assertEqual(s[name]["network_mode"], "none")
            self.assertEqual(s[name]["restart"], "no")
        for name in ("kubo", "gateway"):
            self.assertEqual(s[name]["network_mode"], "host")
            self.assertNotIn("ports", s[name])
            self.assertEqual(s[name]["restart"], "unless-stopped")
            self.assertIn("healthcheck", s[name])
            self.assertGreater(int(s[name]["mem_limit"]), 0)
        for service in s.values():
            self.assertTrue(service["read_only"])
            self.assertEqual(service["user"], "1000:1000")
            self.assertIn("ALL", service["cap_drop"])
            self.assertIn("no-new-privileges:true", service["security_opt"])
            self.assertEqual(service["logging"]["options"]["max-file"], "3")
            self.assertNotIn(":latest", service["image"])
        self.assertEqual(s["kubo"]["command"], ["daemon", "--enable-gc=false", "--migrate=false"])
        self.assertEqual(s["configure"]["depends_on"]["init"]["condition"], "service_completed_successfully")
        self.assertEqual(s["kubo"]["depends_on"]["configure"]["condition"], "service_completed_successfully")
        self.assertEqual(s["gateway"]["depends_on"]["kubo"]["condition"], "service_healthy")
        self.assertTrue(m["volumes"]["data"]["external"])

    def test_raw_cids_and_local_gateway(self):
        c = json.loads((ROOT / "kubo-config.json").read_text())
        self.assertEqual(c["Addresses"]["API"], "/ip4/127.0.0.1/tcp/5001")
        self.assertEqual(c["Addresses"]["Gateway"], "/ip4/127.0.0.1/tcp/8080")
        self.assertEqual(c["Importer"], {"CidVersion": 1, "RawLeaves": True,
            "Chunker": "size-1048576", "HashFunction": "sha2-256"})
        self.assertIs(c["Gateway"]["NoFetch"], True)
        self.assertEqual(c["Gateway"]["HTTPHeaders"]["Access-Control-Allow-Origin"], ["https://squarehole.fun"])
        self.assertEqual(c["Datastore"]["StorageMax"], "20GB")
        self.assertNotIn("Identity", c)
        self.assertNotIn("Spec", c["Datastore"])

    def test_merge_preserves_identity_and_datastore(self):
        service = model()["services"]["configure"]
        self.assertEqual(service["entrypoint"], ["python3", "-c"])
        script = service["command"][0]
        repo = SCRATCH / "repo"
        repo.mkdir()
        path = repo / "config"
        original = {"Identity": {"PeerID": "fake-peer", "PrivKey": "FAKE_PRIVATE_KEY"},
            "Datastore": {"Spec": {"type": "mount", "mounts": []}, "StorageMax": "10GB"},
            "Gateway": {"NoFetch": False}, "Routing": {"Type": "auto"}}
        path.write_text(json.dumps(original))
        path.chmod(0o600)
        env = {**ENV, "IPFS_PATH": str(repo), "SH_IPFS_PATCH": str(ROOT / "kubo-config.json")}
        for _ in range(2):
            result = subprocess.run(["python3", "-c", script], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertNotIn("FAKE_PRIVATE_KEY", result.stdout + result.stderr)
            merged = json.loads(path.read_text())
            self.assertEqual(merged["Identity"], original["Identity"])
            self.assertEqual(merged["Datastore"]["Spec"], original["Datastore"]["Spec"])
            self.assertEqual(merged["Routing"], original["Routing"])
            self.assertTrue(merged["Gateway"]["NoFetch"])
            self.assertEqual(merged["Datastore"]["StorageMax"], "20GB")
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        bad = SCRATCH / "bad.json"
        bad.write_text('{"Identity": {"PrivKey": "FAKE_REPLACEMENT"}}')
        before = path.read_bytes()
        result = subprocess.run(["python3", "-c", script], env={**env, "SH_IPFS_PATCH": str(bad)},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), before)
        self.assertNotIn("FAKE_REPLACEMENT", result.stdout + result.stderr)

    def test_init_is_once_and_health_requires_daemon(self):
        s = model()["services"]
        fakebin = SCRATCH / "bin"
        fakebin.mkdir()
        ipfs = fakebin / "ipfs"
        ipfs.write_text('#!/bin/sh\nset -eu\nprintf "%s\\n" "$*" >> "$FAKE_CALLS"\n'
            'if [ "$1" = init ]; then printf "{}" > "$IPFS_PATH/config"; fi\n'
            'case "$*" in *" id") exit "$FAKE_DAEMON_STATUS" ;; esac\n')
        ipfs.chmod(0o700)
        repo = SCRATCH / "init-repo"
        repo.mkdir()
        calls = SCRATCH / "calls"
        env = {**ENV, "PATH": str(fakebin.resolve()) + os.pathsep + os.environ["PATH"],
            "IPFS_PATH": str(repo), "FAKE_CALLS": str(calls), "FAKE_DAEMON_STATUS": "0"}
        script = s["init"]["command"][0].replace("$$", "$")
        for _ in range(2):
            result = subprocess.run(["sh", "-ec", script], env=env, capture_output=True)
            self.assertEqual(result.returncode, 0)
        self.assertEqual(calls.read_text().splitlines(), ["init --profile=server"])
        health = s["kubo"]["healthcheck"]["test"]
        self.assertEqual(health[0], "CMD-SHELL")
        self.assertIn("--api=/ip4/127.0.0.1/tcp/5001", health[1])
        for status in ("0", "1"):
            result = subprocess.run(["sh", "-ec", health[1]],
                env={**env, "FAKE_DAEMON_STATUS": status}, capture_output=True)
            self.assertEqual(result.returncode, int(status))

    def test_proxy_surface(self):
        caddy = (ROOT / "Caddyfile").read_text()
        self.assertIn("http://127.0.0.1:8090", caddy)
        self.assertIn("bind 127.0.0.1", caddy)
        self.assertIn("admin off", caddy)
        self.assertIn("method GET HEAD", caddy)
        self.assertIn("^/ipfs/bafkrei[a-z2-7]{52}$", caddy)
        self.assertIn("reverse_proxy 127.0.0.1:8080", caddy)
        self.assertIn('respond "not found" 404', caddy)
        self.assertIn("response_header_timeout 2s", caddy)
        self.assertNotIn("file_server", caddy)

unittest.main(verbosity=2)
```
