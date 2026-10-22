#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js and restart Git Bash."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js and restart Git Bash."
  exit 1
fi

echo "Checking MongoDB and creating demo records..."
npm --workspace services/api run seed

cleanup() {
  echo
  echo "Stopping TechLoop demo..."
  kill "$API_PID" "$ADMIN_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Starting API on http://localhost:4000..."
npm run dev:api &
API_PID=$!

echo "Starting admin interface on http://localhost:5173..."
npm run dev:admin &
ADMIN_PID=$!

echo
echo "TechLoop is running."
echo "Admin: http://localhost:5173"
echo "API:   http://localhost:4000/health"
echo "Press Ctrl+C to stop both services."
echo

wait "$API_PID" "$ADMIN_PID"
