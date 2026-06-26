#!/bin/bash
if [ -z "$1" ]; then
    echo "Please provide a commit message."
    exit 1
fi

uv run build.py || exit 1
git add .gitignore index.html styles.css app.js data.js build.py deploy.sh dev.sh encrypted_photos/ *.example */index.html
git commit -m "$1"
git push
