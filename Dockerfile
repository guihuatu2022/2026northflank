# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build arguments
#
# SING_BOX_VERSION pins the upstream engine. Do not use a floating tag: the
# configuration format has breaking changes between minor releases.
# ---------------------------------------------------------------------------
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=gcr.io/distroless/static:nonroot
ARG SING_BOX_VERSION=v1.14.0

# ---------------------------------------------------------------------------
# Stage 1: upstream engine
#
# sing-box is compiled with a deliberately reduced feature set. Upstream ships
# QUIC, WireGuard, gVisor, ACME, the Clash API, Tailscale, naive, cloudflared,
# OpenVPN, USB/IP and more; none of it is reachable in a server that only needs
# VLESS over WebSocket with a direct outbound. `badlinkname` and
# `tfogo_checklinkname0` are required by upstream's own linker flags and must
# stay.
# ---------------------------------------------------------------------------
FROM ${GO_IMAGE} AS engine

ARG SING_BOX_VERSION

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth 1 --branch "${SING_BOX_VERSION}" \
        https://github.com/SagerNet/sing-box.git .

ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local

RUN go build -v -trimpath \
        -tags "badlinkname tfogo_checklinkname0" \
        -ldflags "-X github.com/sagernet/sing-box/constant.Version=${SING_BOX_VERSION} -X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid=" \
        -o /out/engine ./cmd/sing-box \
 && /out/engine version

# ---------------------------------------------------------------------------
# Stage 2: gateway (entrypoint, supervisor and public-port handler)
#
# Standard library only, so this stage needs no module downloads.
# ---------------------------------------------------------------------------
FROM ${GO_IMAGE} AS gateway

ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local

WORKDIR /src
COPY front/ ./

RUN go build -v -trimpath -ldflags "-s -w -buildid=" -o /out/gateway .

# ---------------------------------------------------------------------------
# Stage 3: empty directory with the ownership the runtime user needs.
#
# The image is distroless and runs unprivileged, so a writable directory must
# be created here: no shell is available at runtime to do it.
# ---------------------------------------------------------------------------
FROM ${GO_IMAGE} AS appdir

RUN mkdir -p /app && chown 65532:65532 /app

# ---------------------------------------------------------------------------
# Stage 4: runtime
# ---------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}

LABEL org.opencontainers.image.title="nf-node" \
      org.opencontainers.image.description="Unprivileged VLESS-over-WebSocket origin for a Cloudflare-fronted tunnel node" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/OWNER/REPO"

COPY --from=appdir --chown=65532:65532 /app /app

# /app/gateway is our entrypoint; /app/engine is sing-box. Neutral file names
# keep the process list free of protocol keywords.
COPY --from=engine  --chown=65532:65532 /out/engine  /app/engine
COPY --from=gateway --chown=65532:65532 /out/gateway /app/gateway

# GPL-3.0 compliance: the licence texts travel inside the image.
COPY --chown=65532:65532 LICENSE                    /app/LICENSE
COPY --chown=65532:65532 THIRD_PARTY_NOTICES.md     /app/THIRD_PARTY_NOTICES.md
COPY --chown=65532:65532 third_party/               /app/third_party/

# Ports are documentation only: the platform decides what is published.
# The platform must expose LISTEN_PORT (default 8080) and nothing else.
EXPOSE 8080

ENV LISTEN_PORT=8080 \
    UPSTREAM_PORT=9000 \
    SINGBOX_BIN=/app/engine \
    CONFIG_PATH=/app/config.json \
    LOG_LEVEL=warn \
    MAX_EARLY_DATA=2048 \
    MAX_CONNS=300

USER 65532:65532

ENTRYPOINT ["/app/gateway"]
