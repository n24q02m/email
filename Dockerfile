# email - Email (IMAP/SMTP) MCP server, optimized for AI agents
# Multi-target Dockerfile: `:stdio` (default for clients) + `:http` (self-hosted daemon).
# See spec 2026-04-30-multi-mode-stdio-http-architecture.md.
# syntax=docker/dockerfile:1

# Build stage (shared by both targets)
FROM oven/bun:1-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

# Build the package
RUN bun run build

# Base runtime stage (shared)
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS base

LABEL org.opencontainers.image.source="https://github.com/n24q02m/email"
LABEL io.modelcontextprotocol.server.name="io.github.n24q02m/better-email-mcp"

# Copy built package from builder stage
COPY --from=builder /app/build /usr/local/lib/node_modules/@n24q02m/email/build
COPY --from=builder /app/bin /usr/local/lib/node_modules/@n24q02m/email/bin
COPY --from=builder /app/package.json /usr/local/lib/node_modules/@n24q02m/email/
COPY --from=builder /app/README.md /usr/local/lib/node_modules/@n24q02m/email/
COPY --from=builder /app/LICENSE /usr/local/lib/node_modules/@n24q02m/email/
COPY --from=builder /app/node_modules /usr/local/lib/node_modules/@n24q02m/email/node_modules

# Create symlinks for CLI (email + legacy better-email-mcp alias) and grant the
# non-root runtime user access to the self-hosted HTTP credential volume.
RUN ln -s /usr/local/lib/node_modules/@n24q02m/email/bin/cli.mjs /usr/local/bin/email \
  && ln -s /usr/local/lib/node_modules/@n24q02m/email/bin/cli.mjs /usr/local/bin/better-email-mcp \
  && mkdir -p /data \
  && chown node:node /data

# Set default environment variables
ENV NODE_ENV=production

# Run as non-root user for security
USER node

# stdio target: direct MCP SDK StdioServerTransport (no daemon hop).
# Intended for `docker run --rm -i n24q02m/email:stdio` from MCP clients.
FROM base AS stdio
ENV MCP_TRANSPORT=stdio
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/email/bin/cli.mjs"]

# http target: single-user HTTP daemon (startHttp, bearer token via EMAIL_MCP_TOKEN_HASH). Self-hosted deployment.
FROM base AS http
ENV MCP_TRANSPORT=http \
    MCP_PORT=8080 \
    HOME=/data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@n24q02m/email/bin/cli.mjs"]
