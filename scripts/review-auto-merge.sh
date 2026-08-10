#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <pr-number>" >&2
}

pr_number="${1:-${PR_NUMBER:-${GITHUB_PR_NUMBER:-${INPUT_PR_NUMBER:-}}}}"
if [ -z "$pr_number" ]; then
  usage
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 127
fi

is_draft="$(gh pr view "$pr_number" --json isDraft --jq '.isDraft')"

has_label() {
  local needle="$1"
  grep -Fxq "$needle"
}

ci_status() {
  gh pr view "$pr_number" --json statusCheckRollup --jq '
    [.statusCheckRollup[]? | (.conclusion // .state // "UNKNOWN")] as $states
    | if ($states | length) == 0 then "PENDING"
      elif any($states[]; . == "FAILURE" or . == "ERROR" or . == "CANCELLED" or . == "TIMED_OUT" or . == "ACTION_REQUIRED") then "FAILURE"
      elif all($states[]; . == "SUCCESS" or . == "SKIPPED" or . == "NEUTRAL") then "SUCCESS"
      else "PENDING"
      end
  '
}

if [ "$is_draft" = "true" ]; then
  echo "PR #$pr_number is draft"

  labels="$(gh pr view "$pr_number" --json labels --jq '.labels[].name')"
  if printf '%s\n' "$labels" | has_label "draft:hold"; then
    echo "Skipping: draft:hold label present"
    exit 0
  fi

  status="$(ci_status)"
  if [ "$status" != "SUCCESS" ]; then
    echo "Skipping: CI not passing (status: $status)"
    exit 0
  fi

  echo "Converting draft PR #$pr_number to ready for review..."
  gh pr ready "$pr_number"
  echo "Converted draft PR #$pr_number to ready for review"
fi

echo "Enabling auto-merge for PR #$pr_number..."
gh pr merge "$pr_number" --auto --squash
echo "Auto-merge enabled for PR #$pr_number"
