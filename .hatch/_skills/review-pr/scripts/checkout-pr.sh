#!/usr/bin/env bash
# Fetch and check out a GitHub PR branch by number.
set -euo pipefail
pr="${1:?usage: checkout-pr.sh <pr-number>}"
gh pr checkout "$pr"
