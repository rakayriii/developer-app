#!/bin/sh
# Disposable remote deployment host for real Phase 11 and Phase 12 verification.
#
# Test infrastructure, not part of the Developer OS application. It provides a genuinely separate remote
# host: its own Docker daemon, image store, filesystem, SSH server, and ports 80 and 443, so a reverse
# proxy verified against it really terminates connections on that host.
#
# A shell pipeline is fine here: the Developer OS deployment engine never uses a shell for any local or
# remote Docker operation.
set -e

# The harness generates a throwaway key pair per run and passes the public half in. Installing it here
# keeps the image's committed fixture unchanged, so running verification does not dirty the repository.
# When REMOTE_KEY is absent the image's own fixture is left in place, which is what a plain `docker run`
# without the variable gets.
if [ -n "$REMOTE_KEY" ]; then
  printf '%s\n' "$REMOTE_KEY" > /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
fi

mkdir -p /run/sshd
/usr/sbin/sshd -e

# The nested daemon must be started through the `dind` wrapper. Starting dockerd directly fails on a
# cgroup v2 host with "cannot enter cgroupv2 ... with domain controllers", because the cgroup namespace is
# never initialised. That is a property of nested containers, not of the application.
exec dind dockerd --host=unix:///var/run/docker.sock