#!/usr/bin/env bash
set -euo pipefail

export PATH="$PWD/mock_bin:$PATH"
mkdir -p mock_bin
cat << 'MOCK' > mock_bin/gh
#!/usr/bin/env bash
# echo "Mock gh called with: $*" >&2
if [[ "$*" == *"pr view 123 --json isDraft --jq .isDraft"* ]]; then echo "true"; exit 0; fi
if [[ "$*" == *"pr view 123 --json labels --jq .labels[].name"* ]]; then echo ""; exit 0; fi
if [[ "$*" == *"pr view 123 --json statusCheckRollup"* ]]; then echo "SUCCESS"; exit 0; fi

if [[ "$*" == *"pr view 456 --json isDraft --jq .isDraft"* ]]; then echo "false"; exit 0; fi
if [[ "$*" == *"pr view 456 --json labels --jq .labels[].name"* ]]; then echo ""; exit 0; fi
if [[ "$*" == *"pr view 456 --json statusCheckRollup"* ]]; then echo "SUCCESS"; exit 0; fi

if [[ "$*" == *"pr ready"* ]]; then exit 0; fi
if [[ "$*" == *"pr merge"* ]]; then exit 0; fi

echo "Unhandled mock gh call: $*" >&2
exit 1
MOCK
chmod +x mock_bin/gh

echo "Running tests for review-auto-merge.sh..."

echo "Test 1: Draft PR (123)"
output=$(./review-auto-merge.sh 123)
if echo "$output" | grep -q "PR #123 is draft"; then
  echo "✅ Draft detection passed"
else
  echo "❌ Draft detection failed"
  echo "Output was: $output"
  exit 1
fi

echo "Test 2: Ready PR (456)"
output=$(./review-auto-merge.sh 456)
if ! echo "$output" | grep -q "PR #456 is draft"; then
  echo "✅ Ready detection passed (did not log draft)"
else
  echo "❌ Ready detection failed (logged draft)"
  echo "Output was: $output"
  exit 1
fi

rm -rf mock_bin
echo "All tests passed!"
