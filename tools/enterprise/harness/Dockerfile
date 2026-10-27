# Test image: Google Chrome stable (linux amd64; runs under Rosetta on Apple silicon)
FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates gnupg python3 libnss3-tools openssl curl xvfb \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-liberation \
 && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
