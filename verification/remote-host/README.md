# Disposable remote deployment host

Test infrastructure for Phase 11 verification, not part of the Developer OS application.

This image provides a **genuinely separate** remote host: its own Docker daemon, its own image store, its
own filesystem, and its own SSH server. A remote deployment verified against it exercises the real
transfer, image load, container start, release command, and health check rather than a simulation. The
local daemon is a different process with a different image store, so a transfer cannot be faked by a
local image that happens to already exist.

## What is required

- **SSH** with public-key authentication only. The remote deployment engine pins this host's key and
  refuses to connect otherwise.
- **Docker** capable of creating containers, which on a cgroup v2 host means the nested daemon has to be
  started through the `dind` wrapper. Starting `dockerd` directly fails with
  `cannot enter cgroupv2 "/sys/fs/cgroup/docker" with domain controllers`, because the cgroup namespace is
  never initialised. `start-remote.sh` delegates to `dind` for exactly this reason.
- **curl**, which the remote health check uses after a capability probe confirms it is present.

## Fixture key

`authorized_keys` is a throwaway public key generated solely for this harness. It authenticates to
nothing beyond a container that is created and destroyed for verification. It is public key material, not
a credential.

## Running it

```bash
docker build -t developer-os/verification-remote-host verification/remote-host
docker run -d --name developer-os-remote-dind --privileged -p 2222:22 \
  -e DOCKER_TLS_CERTDIR= developer-os/verification-remote-host
```

Then run the verification with `SSHD_DIR` pointing at the private key matching this image's
`authorized_keys`:

```bash
SSHD_DIR=/path/to/keys node --experimental-strip-types --import ./scripts/register.mjs scripts/verify-remote.mjs
```

`--privileged` is required for the nested daemon. It applies to this disposable verification container
only; the containers Developer OS deploys are created without privileged mode, host networking, mounts,
capabilities, or the Docker socket, and that is asserted in `test/remote-security.test.mjs`.
