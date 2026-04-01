#!/bin/bash
# Deploy to MacStudio
# Usage: ./deploy.sh

set -e

PLATFORM_DIR="$HOME/Documents/GitHub/platform"
source "$PLATFORM_DIR/lib/shell/macstudio_connect.sh"

echo "Deploying to MacStudio ($MACSTUDIO_NETWORK)..."

PROJECT_NAME="$(basename "$(pwd)")"
REMOTE_DIR="/Users/hjalti/${PROJECT_NAME}-deploy"

rsync -avz --exclude '.git' --exclude 'node_modules' --exclude '__pycache__' --exclude '.venv' --exclude 'target' \
    ./ "${MACSTUDIO_USER}@${MACSTUDIO_HOST}:${REMOTE_DIR}/"

echo "Files synced to ${REMOTE_DIR}"
echo "Deploy complete!"

source "$PLATFORM_DIR/lib/shell/telegram.sh"
send_telegram "Deploy complete: ${PROJECT_NAME} to MacStudio ($MACSTUDIO_NETWORK)"
