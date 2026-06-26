#!/bin/bash
echo "🚀 Building encrypted photo gallery..."
uv run build.py || exit 1

PORT=${1:-8080}
echo ""
echo "========================================================"
echo "🌐 Gallery live at: http://localhost:${PORT}"
if [ -f PASSWORD ]; then
  echo "🔑 Master Password: $(cat PASSWORD)"
fi
echo "========================================================"
echo "Press Ctrl+C to stop the server."
echo ""

python3 -m http.server ${PORT}
