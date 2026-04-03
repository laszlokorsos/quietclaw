#!/bin/bash
# Dev environment setup for QuietClaw
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== QuietClaw Dev Setup ==="
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install with: brew install node"
    exit 1
fi
echo "✅ Node.js $(node -v)"

if ! command -v pnpm &> /dev/null; then
    echo "❌ pnpm not found. Install with: npm install -g pnpm"
    exit 1
fi
echo "✅ pnpm $(pnpm -v)"

if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found. Install with: brew install python3"
    exit 1
fi
echo "✅ Python3 $(python3 --version | awk '{print $2}')"

# Check macOS version
MACOS_VERSION=$(sw_vers -productVersion)
MAJOR_VERSION=$(echo "$MACOS_VERSION" | cut -d. -f1)
if [ "$MAJOR_VERSION" -lt 13 ]; then
    echo "❌ macOS 13+ required. You have macOS $MACOS_VERSION"
    exit 1
fi
echo "✅ macOS $MACOS_VERSION"

echo ""
echo "Installing dependencies..."
cd "$PROJECT_DIR"
pnpm install

echo ""
echo "Building native addon..."
bash scripts/build-native.sh

echo ""
echo "=== Setup complete ==="
echo ""
echo "To start development:"
echo "  pnpm run dev"
echo ""
echo "You will need to grant Screen Recording permission on first run."
