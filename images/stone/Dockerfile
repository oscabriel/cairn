# The stone's base image: the arms a stone's tools run in, on Cloudflare Containers. Built only in GitHub Actions
# (.github/workflows/stone-image.yml), never on the Beelink, and deployed by digest.
#
# Node 24 on bookworm-slim, plus git, the Sandbox SDK's shim at the path its Files class expects, and pi-env's static
# daemon, which the brain talks to over the link (ADR 0010). Every base is pinned by digest and the daemon by its
# sha256. No credential is ever built in. Ported from cairn-v1 apps/cloud-sandbox/container/Dockerfile.
FROM docker.io/cloudflare/sandbox:1.0.2@sha256:c2733169f130f73ba4f1cc0de169570936145ed013fbdf63707bf7d5386a4b81 AS sandbox-tools

# pi-env's daemon comes from its npm package, checked against the sha256 Cairn pins for that version.
FROM docker.io/library/node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS daemon
ARG PI_ENV_VERSION=1.4.0
ARG PI_ENV_SHA256=46dde0e25b5cf1a327a10ddcb25f746f85b783492f5b225dfaa1a0d84cf5b56a
WORKDIR /build
RUN npm pack "@earendil-works/pi-env@${PI_ENV_VERSION}" --silent \
	&& tar xzf "earendil-works-pi-env-${PI_ENV_VERSION}.tgz" package/bin/pi-env-linux-x64/pi-env \
	&& echo "${PI_ENV_SHA256}  package/bin/pi-env-linux-x64/pi-env" | sha256sum -c -

FROM docker.io/library/node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates procps \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --from=daemon /build/package/bin/pi-env-linux-x64/pi-env /opt/pi-env/pi-env
RUN chmod 0555 /opt/pi-env/pi-env /usr/local/bin/sandbox-shim \
	&& mkdir -p /cairn/workspace \
	&& chown -R 1000:1000 /cairn \
	&& ln -s /cairn/workspace /workspace
# uid 1000 is the image's `node` user.
USER 1000:1000
ENV HOME=/tmp
WORKDIR /workspace
CMD ["sleep", "infinity"]
