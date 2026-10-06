#!/bin/sh
# Starts the SSH server, then hands over to the DinD wrapper. A shell pipeline is fine here: this is
# disposable verification infrastructure, not application code. The Developer OS deployment engine
# never uses a shell for any local or remote Docker operation.
set -e

mkdir -p /run/sshd
/usr/sbin/sshd -e

exec dind dockerd --host=unix:///var/run/docker.sock
