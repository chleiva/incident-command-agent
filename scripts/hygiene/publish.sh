#!/usr/bin/env bash
# Copyright 2026 Incident Command Agent contributors
# SPDX-License-Identifier: Apache-2.0
#
# Publish the current local `main` tree to GitHub as ONE commit on the squashed public line
# (`public/main` -> origin/main). Local history is never pushed. Usage: scripts/hygiene/publish.sh "<title>" ["<body>"]
set -euo pipefail
title="${1:?usage: publish.sh <title> [body]}"; body="${2:-}"
cd "$(git rev-parse --show-toplevel)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "working tree has uncommitted changes" >&2; exit 1; }
if [ -s config/private-words.txt ]; then
  if git grep -qiwf config/private-words.txt -- . ':!config/private-words.txt'; then echo "private word found in tree" >&2; exit 1; fi
fi
if git grep -qE 'sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then echo "secret-shaped string found in tree" >&2; exit 1; fi
if [ "$(git rev-parse HEAD^{tree})" = "$(git rev-parse public/main^{tree})" ]; then echo "nothing new to publish"; exit 0; fi
msg="$title"; [ -n "$body" ] && msg="$msg

$body"
msg="$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SzzkBz1sw8NrZKtFstfp6V"
c=$(git commit-tree "HEAD^{tree}" -p public/main -m "$msg")
git branch -f public/main "$c"
git push origin public/main:main
