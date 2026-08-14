# Standalone sandbox API Dockerfile (development)
# Boots the sandbox server inside a libkrun microVM with its own kernel.
# Only requires /dev/kvm on the host — no privileged mode, no capabilities.
#
# Build context: services/codeapi/api/  (for standalone) or services/codeapi/ (see note)
# Note: This Dockerfile references ../launcher/ so the build context must be
# the codeapi directory when using docker compose (context: .).

# ============================================================================
# Stage 1: Build NsJail from source
# ============================================================================
FROM buildpack-deps:bookworm AS nsjail-builder

WORKDIR /nsjail

RUN apt-get update && apt-get install -y --no-install-recommends \
    bison \
    flex \
    libprotobuf-dev \
    libnl-route-3-dev \
    protobuf-compiler \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

RUN git clone -b master --single-branch https://github.com/google/nsjail.git . \
    && git checkout 66ad78dc361721512fbf9470488e584364c75489 \
    && git submodule update --init --recursive

RUN make -j$(nproc)

COPY api/src/spec-guard.c /tmp/spec-guard.c
RUN gcc -O2 -static -o /usr/local/bin/spec-guard /tmp/spec-guard.c \
    && chmod 0111 /usr/local/bin/spec-guard

# ============================================================================
# Stage 1b: Build language runtime packages (only consumed by sandbox-runner-baked)
#
# Mirrors docker/Dockerfile.package-init but runs at image-build time so the
# rendered /pkgs tree can be baked into the runner rootfs. Cache key is the
# package-init script + javascript-packages.txt; unchanged inputs reuse this
# layer across runner rebuilds.
# ============================================================================
FROM buildpack-deps:bookworm AS package-builder

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHON_VERSION=3.14.4
ENV BUN_VERSION=1.3.14

COPY docker/apt-install.sh /usr/local/bin/apt-install
RUN chmod +x /usr/local/bin/apt-install

RUN apt-install \
    curl unzip wget ca-certificates \
    build-essential libssl-dev libffi-dev libsqlite3-dev \
    zlib1g-dev libbz2-dev libreadline-dev libncurses5-dev \
    tk-dev xz-utils libcurl4-openssl-dev libfontconfig1-dev \
    libudunits2-dev libpng-dev libxml2-dev libcairo2-dev \
    libfreetype6-dev

RUN mkdir -p /pkgs

COPY docker/package-init.sh /package-init.sh
COPY javascript-packages.txt /javascript-packages.txt
RUN chmod +x /package-init.sh && FORCE_REBUILD=true /package-init.sh

# ============================================================================
# Stage 1b: Materialize a relocatable Chromium prefix for the MicroVM runner
#
# `sandbox-build` removes apt/dpkg (see the rm block below) and strips every
# setuid bit image-wide, so the browser cannot be installed there. It is also
# the source of the K8s ext4 block root (`COPY --from=sandbox-build /` in
# sandbox-rootfs-image), so installing into it would inflate every K8s runner
# pod for a feature that needs a persistent session workspace K8s does not run.
#
# The prefix lands at /opt/browser and is COPY'd only into
# lambda-microvm-runner. /opt is deliberately not one of the paths sandbox.cfg
# mounts into the jail, so sandboxed code cannot exec the browser directly.
#
# Basing this on the same image as sandbox-build is what makes
# `--download-only` correct: apt resolves the dependency closure against the
# pristine base, and sandbox-build only ever adds packages to that same base,
# so the closure is a guaranteed superset of what the runner is missing. No
# hand-maintained library list, no ldd walk, no glibc skew.
# ============================================================================
FROM oven/bun:1.3.14-debian AS chromium-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends --download-only \
      chromium fonts-noto-color-emoji \
 && mkdir -p /opt/browser \
 && for deb in /var/cache/apt/archives/*.deb; do dpkg-deb -x "$deb" /opt/browser; done \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
 && ln -s "usr/lib/$(basename "$(ls -d /opt/browser/usr/lib/*-linux-gnu | head -1)")" \
      /opt/browser/lib-multiarch \
 && test -e /opt/browser/lib-multiarch/libnss3.so

# ============================================================================
# Stage 2: Build sandbox rootfs
# ============================================================================
FROM oven/bun:1.3.14-debian AS sandbox-build

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    coreutils \
    util-linux \
    bsdextrautils \
    locales \
    procps \
    iptables \
    bc \
    file \
    jq \
    poppler-utils \
    fonts-dejavu \
    fonts-liberation \
    libnl-route-3-200 \
    libprotobuf32 \
    libffi8 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && libffi=$(find /usr/lib -name 'libffi.so.8' -print -quit) \
    && { [ -n "$libffi" ] || { echo "libffi.so.8 not found" >&2; exit 1; }; } \
    && ln -sf "$libffi" "${libffi%.so.8}.so.6"

# Restore the standard Debian `awk` -> `mawk` symlink. mawk is Priority:
# required so its binary is in /usr/bin already, but slim base images skip
# the mawk postinst's `update-alternatives --install /usr/bin/awk awk
# /usr/bin/mawk 5` step that normally creates the user-facing `awk`
# command. Without this, bare `awk ...` in user shell scripts fails with
# `command not found` even though mawk itself is present. Identical
# security surface to the existing pure-text utilities (sed, tr,
# coreutils) — mawk has no system() / getline-from-command extensions
# in its minimal build.
RUN [ -x /usr/bin/mawk ] && ln -sf /usr/bin/mawk /usr/bin/awk

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

COPY --from=nsjail-builder /nsjail/nsjail /usr/sbin/nsjail
COPY --from=nsjail-builder /usr/local/bin/spec-guard /usr/local/bin/spec-guard
RUN chmod +x /usr/sbin/nsjail

# The tool-call socket proxy must run under Node, not Bun. Bun's node:http
# compat layer never fires `'connection'` events and Bun.serve's idleTimeout
# does not close silent unix-socket connections — so our DoS protections
# (maxConnections, idleSocketTimeoutMs, accept-time tracking) silently no-op
# under Bun and a `for i in range(N): socket.connect` storm pins FDs in the
# proxy until the OS limit. Pulling just the Node binary from a slim image
# is ~30 MB and avoids inheriting npm/node_modules from a full apt install.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node

WORKDIR /sandbox_api

COPY api/package.json api/bun.lock ./
RUN bun install --frozen-lockfile

COPY api/tsconfig.json ./
COPY api/src ./src
COPY shared /shared
COPY api/config ./config

RUN bun run build

RUN mkdir -p /pkgs /tmp/sandbox

RUN find / -xdev -perm /6000 -exec chmod ug-s {} + 2>/dev/null || true

RUN rm -f /usr/bin/nsenter /usr/bin/unshare /usr/bin/chroot /usr/sbin/chroot \
         /usr/bin/perl* /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg \
         /usr/sbin/adduser /usr/sbin/useradd /usr/sbin/usermod \
         /usr/sbin/groupadd /usr/sbin/groupmod \
         /usr/bin/su \
         /usr/bin/chfn /usr/bin/chsh /usr/bin/gpasswd /usr/bin/newgrp \
         /usr/bin/passwd /usr/bin/sg \
         /usr/bin/chage /usr/bin/expiry /usr/sbin/unix_chkpwd \
    2>/dev/null || true

COPY api/src/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# ============================================================================
# Stage 2b: AWS Lambda MicroVM container base image
#
# Lambda MicroVM IS the VM boundary: no libkrun launcher, no guest kernel.
# This target is pushed to a same-account ECR repo and referenced by the
# FROM line of the code-artifact Dockerfile that Lambda builds on top of
# the AL2023 MicroVM base image (see scripts/build-lambda-microvm-artifact.sh).
# Inbound traffic defaults to port 8080; lifecycle/build hooks are served
# by the same app at /aws/lambda-microvms/runtime/v1/*.
# ============================================================================
FROM sandbox-build AS lambda-microvm-runner

COPY --from=package-builder /pkgs /pkgs
COPY --from=chromium-builder /opt/browser /opt/browser

# The image-wide `chmod ug-s` in sandbox-build runs before this stage, so it
# never sees /opt/browser. Chromium's SUID sandbox helper would arrive with its
# setuid bit intact and silently violate that invariant; the browser launches
# with --no-sandbox (the MicroVM is the trust boundary) so the helper is unused.
RUN chmod ug-s /opt/browser/usr/lib/chromium/chrome-sandbox 2>/dev/null || true

# Browser paths are image facts, so they are baked here. SANDBOX_BROWSER_ENABLED
# is deliberately NOT set: the browse route stays 404 until an operator opts in
# via `create-microvm-image.ts --env-json '{"SANDBOX_BROWSER_ENABLED":"true"}'`.
ENV PORT=8080 \
    SANDBOX_PACKAGES_DIRECTORY=/pkgs \
    SANDBOX_SESSION_WORKSPACE_ENABLED=true \
    SANDBOX_BROWSER_BINARY=/opt/browser/usr/lib/chromium/chromium \
    SANDBOX_BROWSER_LIBRARY_PATH=/opt/browser/lib-multiarch:/opt/browser/lib-multiarch/pulseaudio:/opt/browser/usr/lib/chromium \
    SANDBOX_BROWSER_FONTCONFIG_PATH=/opt/browser/etc/fonts \
    SANDBOX_BROWSER_CDP_PORT=9222

# CI builds this target with `--output type=cacheonly`, which executes RUN steps
# but never runs the image. These assertions are therefore the only thing standing
# between a broken shared-library closure and a green build.
#
# The ldd check is not redundant with `--version`: Chromium resolves some
# libraries lazily, so `--version` can succeed while a renderer-path dependency
# is missing. libpulsecommon lives in a private `pulseaudio/` subdirectory rather
# than the multiarch root, which is why the library path is not just one entry.
RUN test -d /opt/browser/etc/fonts \
 && test -n "$(ls /usr/share/fonts 2>/dev/null)" \
 && missing="$(LD_LIBRARY_PATH="$SANDBOX_BROWSER_LIBRARY_PATH" \
      ldd "$SANDBOX_BROWSER_BINARY" | grep 'not found' || true)" \
 && { [ -z "$missing" ] || { echo "unresolved browser libraries:"; echo "$missing"; exit 1; }; } \
 && LD_LIBRARY_PATH="$SANDBOX_BROWSER_LIBRARY_PATH" \
    FONTCONFIG_PATH="$SANDBOX_BROWSER_FONTCONFIG_PATH" \
    "$SANDBOX_BROWSER_BINARY" --version

EXPOSE 8080/tcp
ENTRYPOINT ["/sandbox_api/entrypoint.sh"]

# ============================================================================
# Stage 3: Build the Rust launcher binary (Fedora for libkrun ABI)
# ============================================================================
FROM fedora:43 AS launcher-builder

RUN dnf install -y \
    rust cargo \
    libkrun-devel \
    gcc \
    && dnf clean all

WORKDIR /launcher
COPY launcher/Cargo.toml launcher/build.rs ./
COPY launcher/src/ ./src/

RUN cargo build --release

# ============================================================================
# Stage 4: Final launcher image (Fedora for libkrun runtime)
#
# Split into:
#   - sandbox-runner-base : everything except the guest rootfs copy
#   - sandbox-runner      : legacy/direct target; copies rootfs without
#                           packages (packages come from a runtime PVC mount)
#   - sandbox-runner-baked: copies rootfs AND bakes /pkgs from package-builder
#                           (no PVC needed; runner can spread across nodes)
#   - sandbox-runner-{true,false}: Compose aliases selected by KVM_ENABLED
#   - sandbox-runner-default: final alias for the safe baked KVM image
# ============================================================================
FROM fedora:43 AS sandbox-runner-base

RUN dnf install -y --setopt=install_weak_deps=False \
    libkrun \
    socat \
    curl \
    util-linux \
    grep \
    gawk \
    findutils \
    ca-certificates \
    && dnf clean all

COPY --from=launcher-builder /launcher/target/release/sandbox-launcher /usr/local/bin/launcher

COPY launcher/entrypoint.sh /usr/local/bin/launcher-entrypoint.sh
COPY docker/start-direct-sandbox.sh /usr/local/bin/start-direct-sandbox.sh
COPY docker/sandbox-runner-healthcheck.sh /usr/local/bin/sandbox-runner-healthcheck.sh
COPY docker/sandbox-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/launcher-entrypoint.sh /usr/local/bin/start-direct-sandbox.sh /usr/local/bin/sandbox-runner-healthcheck.sh /usr/local/bin/entrypoint.sh

EXPOSE 2000/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

FROM debian:bookworm AS sandbox-rootfs-image

RUN apt-get update && apt-get install -y --no-install-recommends \
    e2fsprogs \
    coreutils \
    gawk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-build / /sandbox-rootfs/
COPY --from=package-builder /pkgs /sandbox-rootfs/pkgs
COPY docker/build-rootfs-image.sh /usr/local/bin/build-rootfs-image.sh

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg
RUN chmod +x /usr/local/bin/build-rootfs-image.sh \
    && /usr/local/bin/build-rootfs-image.sh /sandbox-rootfs /sandbox-rootfs.img

FROM sandbox-runner-base AS sandbox-runner-baked

COPY --from=sandbox-rootfs-image /sandbox-rootfs.img /sandbox-rootfs.img

ENV LAUNCHER_ROOT_DISK=/sandbox-rootfs.img \
    LAUNCHER_ROOT_DISK_READ_ONLY=true \
    LAUNCHER_ROOT_DEVICE=/dev/vda \
    LAUNCHER_ROOT_FSTYPE=ext4 \
    LAUNCHER_ROOT_OPTIONS=ro

FROM sandbox-runner-base AS sandbox-runner

COPY --from=sandbox-build / /sandbox-rootfs/

RUN sed -i '/^cgroup_mem_swap_max/d' /sandbox-rootfs/sandbox_api/config/sandbox.cfg

RUN mkdir -p /host-packages

# Compose derives these aliases from KVM_ENABLED so existing no-KVM overrides
# keep selecting the directory-root image automatically.
FROM sandbox-runner-baked AS sandbox-runner-true
FROM sandbox-runner AS sandbox-runner-false

# Keep the safe KVM image as the Dockerfile default. Direct NsJail and legacy
# virtio-fs deployments can still select --target sandbox-runner explicitly.
FROM sandbox-runner-true AS sandbox-runner-default
