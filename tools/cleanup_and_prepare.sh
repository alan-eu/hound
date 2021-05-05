#!/usr/bin/env bash
set -e
set -x

find notion \( -type f -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.gif" -o -iname "*.mov" -o -iname "*.mp3" -o -iname "*.mp4" -o -iname "*.pdf" \) -print0 | xargs -0 rm

find notion -maxdepth 1 -mindepth 1 \
-not -name 'Belgium *' \
-not -name 'Communities *' \
-not -name 'France *' \
-not -name 'Getting Started *' \
-not -name 'How we work *' \
-not -name 'Inspiration *' \
-not -name 'Spain *' \
-not -name 'Starter Guide *' \
-not -name 'Team *' \
-not -name 'Units *' \
-not -name 'What is Alan *' \
-print0 | xargs -0 rm -rf

cd notion
git init
git add .
git commit -a -m "updated"
