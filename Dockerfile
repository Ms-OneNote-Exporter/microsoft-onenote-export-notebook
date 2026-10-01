# Reproducible image built from the local working tree.
#
# Node 24 LTS, pinned to a patch release rather than the floating `node:24-slim`,
# so two builds of the same commit produce the same base. Node 24 is also what CI
# runs (.github/workflows/ci.yml), so the container and the test suite agree - and
# it is what the other two repos in this set already used for both, so a checkout
# of any of the three behaves the same.
FROM node:24.21.0-bookworm-slim

# ca-certificates for TLS.
#
# git is deliberately NOT installed. The previous image ran
#   RUN git clone https://github.com/.../microsoft-onenote-export-notebook.git /app
# which meant the image contained whatever was on `main` at build time and never
# contained the local working tree - so a local fix could not be container-tested
# at all, and the image silently disagreed with the checkout. The build context
# already has the source, so it is COPYed below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before source, so editing the code does not invalidate the
# expensive npm layer. `npm ci` installs exactly the lockfile and fails loudly if
# package.json and package-lock.json have drifted apart - `npm install` would
# quietly rewrite the lockfile inside the image.
COPY package.json package-lock.json ./
RUN npm ci

# Chromium's system libraries (fonts, shared objects). Needs root for apt.
RUN npx playwright install-deps chromium

# The tool itself. The npm `files` list is irrelevant here: this is not a publish,
# it is the working tree.
COPY src/ ./src/
COPY entrypoint.sh start-container.sh ./
COPY package.json README.md NOTICE.md CHANGELOG.md LICENSE ./

# Browser binaries, installed as the unprivileged `node` user so the cache lives
# in that user's HOME and stays writable after we drop privileges.
USER node
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npx playwright install chromium

# The logger writes to <package>/logs (app.log plus dumps/) and the default
# output dir is <package>/output (see src/config.js). Both live under /app, which
# is root-owned after the COPY above, so a non-root user could not create them and
# the logger's ensureDirSync would throw on startup. Pre-create just those two,
# owned by the runtime user - a recursive chown of node_modules is both slower and
# unnecessary, since nothing writes there.
USER root
RUN mkdir -p /app/logs /app/output && chown -R node:node /app/logs /app/output

USER node

# Chromium needs more than the default 64 MB of shared memory; without this it
# crashes on memory-heavy pages. `--shm-size` is a `docker run` flag, so
# start-container.sh passes it (along with --init to reap Chromium's zombies).
# Documented here so the requirement is not lost.
LABEL org.opencontainers.image.title="microsoft-onenote-export-notebook" \
      org.opencontainers.image.description="Export a Microsoft OneNote notebook to Obsidian-flavoured Markdown" \
      org.opencontainers.image.source="https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/app/entrypoint.sh"]
