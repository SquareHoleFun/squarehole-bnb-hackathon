# syntax=docker/dockerfile:1
# Caddy with the rate-limit handler (github.com/mholt/caddy-ratelimit, not part of standard Caddy), both pinned: the
# Caddy release and the module's commit (master 2026-06-12, "fix(metrics): re-register collectors on each config
# reload"). Go verifies module downloads against the checksum database while building.
FROM caddy:2.11.6-builder@sha256:9fa405e7bb28572759e7c75bea68ed39c4266a509f0c0237c464c6e13ed4dc25 AS builder
RUN xcaddy build v2.11.6 --with github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db

FROM caddy:2.11.6@sha256:907efba736324e43f891ccb9d760fe5abe545e313419b3d18d63d4ec670dad8d
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
