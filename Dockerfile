FROM node:20-slim

# Install git and ca-certificates for cloning the repo and SSL verification
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Clone the microsoft-onenote-export-notebook repository
RUN git clone https://github.com/Ms-OneNote-Exporter/microsoft-onenote-export-notebook.git /app

WORKDIR /app

# Install dependencies
RUN npm install

# Install Playwright browsers and dependencies
RUN npx playwright install-deps && \
    npx playwright install chromium

# Make entrypoint.sh executable and set as entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
