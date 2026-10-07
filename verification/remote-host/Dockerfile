# Disposable remote deployment host for real Phase 11 verification.
#
# This is test infrastructure, not part of the Developer OS application. It provides a genuinely
# separate Docker daemon, filesystem, and image store, reached over SSH, so a remote deployment is
# exercised end to end against something that is not the local daemon.
FROM docker:27-dind

# curl is required: the remote health check verifies availability through a capability probe first,
# then verifies health on the host itself rather than from the Developer OS process.
RUN apk add --no-cache curl

# The Alpine repo ships openssh-client-common and openssh-client-default at mismatched revisions, which
# makes a plain `apk add openssh-server` unresolvable. Pinning both client packages first resolves it.
RUN apk add --no-cache openssh-client-default=9.9_p2-r0 openssh-client-common=9.9_p2-r0 \
 && apk add --no-cache openssh-server

# A placeholder so the image builds and can be run standalone. The verification harness generates a fresh
# throwaway key per run and installs its public half at startup through REMOTE_KEY (see start-remote.sh),
# which keeps this committed fixture stable rather than rewritten on every run.
COPY authorized_keys /root/.ssh/authorized_keys
RUN chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys \
 && ssh-keygen -A \
 && printf 'PermitRootLogin prohibit-password\nPubkeyAuthentication yes\nAuthorizedKeysFile /root/.ssh/authorized_keys\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/developer-os.conf

# Starts sshd, then hands the container over to the DinD entrypoint so cgroups are set up correctly.
# Without the `dind` wrapper the nested daemon cannot create container tasks on a cgroup v2 host.
COPY start-remote.sh /usr/local/bin/start-remote.sh
RUN chmod +x /usr/local/bin/start-remote.sh

# Phase 12: the reverse proxy binds 80 and 443 on this host, so they are published.
EXPOSE 22 80 443
ENTRYPOINT ["/usr/local/bin/start-remote.sh"]
