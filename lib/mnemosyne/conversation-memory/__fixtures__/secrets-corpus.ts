/**
 * cm-01-secret-credential-scanner (epic: mnemosyne-conversation-memory).
 *
 * Checked-in fixture corpus for `scanForSecrets()` (`../scanForSecrets.ts`),
 * per the story's `research` step. Two corpora:
 *
 *  - `POSITIVE_FIXTURES` — real-SHAPED but entirely FAKE/synthetic secrets,
 *    one or more per detected category. Every value here is a made-up
 *    placeholder that matches a real provider's public token FORMAT (prefix,
 *    length, charset) — never a real operator credential of any kind, and
 *    never copied from any real system. Used to measure the scanner's
 *    FALSE-NEGATIVE rate (recall): every entry here MUST be detected.
 *
 *  - `FALSE_POSITIVE_FIXTURES` — real, legitimate, non-secret strings/text
 *    that a naive detector could plausibly misfire on (UUIDs, git commit
 *    hashes, ordinary prose containing words like "key"/"secret"/"password",
 *    URLs with a port but no embedded credentials, etc). Used to measure the
 *    scanner's FALSE-POSITIVE rate: every entry here MUST yield zero
 *    matches.
 *
 * Both corpora are consumed by `scanForSecrets.test.ts`, which computes and
 * reports the real, measured false-negative/false-positive rate as actual
 * test output — never assumed or silently absorbed into a single pass/fail
 * (per this story's acceptance criteria and its `metric` block).
 */

export interface PositiveFixture {
  /** Stable id for test-output reporting. */
  id: string;
  /** Broad category `scanForSecrets()` is expected to assign this fixture. */
  expectedCategory: 'api-key' | 'bearer-token' | 'pem-private-key' | 'connection-string';
  /** Free text (may include surrounding "conversation" context) containing exactly one embedded fake secret. */
  text: string;
  /**
   * The exact raw secret substring embedded in `text` above. Used by the
   * test suite to assert this literal value NEVER appears verbatim in any
   * `scanForSecrets()` match/preview output.
   */
  secretValue: string;
}

export interface FalsePositiveFixture {
  id: string;
  /** Free text that must yield ZERO matches from `scanForSecrets()`. */
  text: string;
}

// ---------------------------------------------------------------------------
// Positive fixtures — fake-but-shaped secrets, one per recognized pattern.
// ---------------------------------------------------------------------------

export const POSITIVE_FIXTURES: readonly PositiveFixture[] = [
  {
    id: 'openai-shaped-sk-key',
    expectedCategory: 'api-key',
    text: 'here is the key I have been using: sk-FAKE1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ12 -- can you check it into the config?',
    secretValue: 'sk-FAKE1a2B3c4D5e6F7g8H9i0JkLmNoPqRsTuVwXyZ12',
  },
  {
    id: 'anthropic-shaped-sk-ant-key',
    expectedCategory: 'api-key',
    text: 'ANTHROPIC_API_KEY=sk-ant-FAKE00api03deadbeefCAFEbabe1122334455667788',
    secretValue: 'sk-ant-FAKE00api03deadbeefCAFEbabe1122334455667788',
  },
  {
    id: 'aws-access-key-id',
    expectedCategory: 'api-key',
    text: 'export AWS_ACCESS_KEY_ID=AKIAFAKE00EXAMPLE123 and the matching secret is in the vault',
    secretValue: 'AKIAFAKE00EXAMPLE123',
  },
  {
    id: 'github-personal-access-token',
    expectedCategory: 'api-key',
    text: 'clone with: git remote set-url origin https://ghp_FAKE0123456789abcdefFAKE0123456789ab@github.com/example/repo.git',
    secretValue: 'ghp_FAKE0123456789abcdefFAKE0123456789ab',
  },
  {
    id: 'slack-bot-token',
    expectedCategory: 'api-key',
    text: 'SLACK_BOT_TOKEN = "xoxb-FAKE000000000-FAKE000000000-fakefakefakefakefakeFAKE"',
    secretValue: 'xoxb-FAKE000000000-FAKE000000000-fakefakefakefakefakeFAKE',
  },
  {
    id: 'slack-user-token',
    expectedCategory: 'api-key',
    text: 'legacy token still in the .env file: xoxp-FAKE111111111-FAKE222222222-FAKE333333333-fakefakefakefakefakefakefakefake',
    secretValue: 'xoxp-FAKE111111111-FAKE222222222-FAKE333333333-fakefakefakefakefakefakefakefake',
  },
  {
    id: 'authorization-bearer-header',
    expectedCategory: 'bearer-token',
    text: 'curl -H "Authorization: Bearer FAKE_tok_9f8e7d6c5b4a3928170615243fakefakefakefake" https://api.example.com/v1/things',
    secretValue: 'FAKE_tok_9f8e7d6c5b4a3928170615243fakefakefakefake',
  },
  {
    id: 'jwt-bearer-token',
    expectedCategory: 'bearer-token',
    text: 'the session cookie decodes to eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIiLCJuYW1lIjoiRmFrZSBVc2VyIn0.FAKEfakeSIGNATUREfakefakefakefakefakefake which is not real',
    secretValue: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIiLCJuYW1lIjoiRmFrZSBVc2VyIn0.FAKEfakeSIGNATUREfakefakefakefakefakefake',
  },
  {
    id: 'pem-rsa-private-key',
    expectedCategory: 'pem-private-key',
    text: [
      'save this to id_rsa:',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIFAKEbase64OnlyForTestingPurposesNotARealKeyAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '-----END RSA PRIVATE KEY-----',
      '',
    ].join('\n'),
    secretValue: [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIFAKEbase64OnlyForTestingPurposesNotARealKeyAAAAAAAAAAAAAAAAAA',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'),
  },
  {
    id: 'pem-openssh-private-key',
    expectedCategory: 'pem-private-key',
    text: [
      'deploy key for the CI box:',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'FAKEb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'),
    secretValue: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'FAKEb3BlbnNzaC1rZXktdjEAAAAAFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'),
  },
  {
    id: 'postgres-connection-string',
    expectedCategory: 'connection-string',
    text: 'DATABASE_URL=postgres://appuser:FAKEpassw0rd123@db.internal.example.com:5432/appdb',
    secretValue: 'appuser:FAKEpassw0rd123',
  },
  {
    id: 'mongodb-srv-connection-string',
    expectedCategory: 'connection-string',
    text: 'set it in the client config: mongodb+srv://svcacct:FAKE-m0ng0-p4ss@cluster0.example.mongodb.net/prod?retryWrites=true',
    secretValue: 'svcacct:FAKE-m0ng0-p4ss',
  },
  {
    id: 'redis-connection-string',
    expectedCategory: 'connection-string',
    text: 'cache client points at redis://default:FAKEredisSecret9@cache.example.internal:6379/0',
    secretValue: 'default:FAKEredisSecret9',
  },
  {
    id: 'amqp-connection-string',
    expectedCategory: 'connection-string',
    text: 'broker URI: amqp://worker:FAKEamqpSecret7@rabbit.example.internal:5672/vhost',
    secretValue: 'worker:FAKEamqpSecret7',
  },
] as const;

// ---------------------------------------------------------------------------
// False-positive fixtures — legitimate, non-secret strings a naive detector
// could plausibly misfire on. Every entry here MUST yield zero matches.
// ---------------------------------------------------------------------------

export const FALSE_POSITIVE_FIXTURES: readonly FalsePositiveFixture[] = [
  { id: 'uuid-v4', text: 'the record id is 550e8400-e29b-41d4-a716-446655440000, filed under the July batch' },
  { id: 'uuid-v4-second', text: 'trace id: 9b2c1e2a-6f0b-4e2e-9a1b-2f3c4d5e6f70 came back from the upstream service' },
  { id: 'git-commit-sha-full', text: 'fixed in commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3, see the changelog' },
  { id: 'git-commit-sha-short', text: 'cherry-picked a94a8fe onto the release branch' },
  { id: 'npm-integrity-hash', text: 'resolved "sha512-oIPzksC4wu5G4GVaU5U5R+++mJm3H7HzDaKVfMy1nD6RD/oykt2ExN+e2rHrDME/DP8bLIx8SGoI/QNjtQxRUw==" from lockfile' },
  { id: 'long-numeric-invoice-id', text: 'invoice number 900182736451029384756 was already paid last quarter' },
  { id: 'hex-color-codes', text: 'brand palette: #1A2B3C primary, #FFAA00 accent, #00FFEE highlight' },
  { id: 'iso-timestamp', text: 'the job started at 2026-03-14T09:26:53.589Z and finished nine minutes later' },
  { id: 'url-with-port-no-credentials', text: 'point the health check at https://internal-svc.example.com:8443/status, no auth needed' },
  { id: 'ssh-style-git-remote-no-password', text: 'clone via git@github.com:example/repo.git over ssh, key auth only' },
  { id: 'url-username-only-no-password', text: 'the anonymous FTP mirror is at ftp://guest@mirror.example.org/pub/' },
  { id: 'db-host-and-port-only', text: 'the read replica lives at postgres.example.internal:5432 in the same VPC' },
  { id: 'prose-mentioning-key-and-secret', text: 'the key to a good retro is psychological safety; no secret sauce required, just consistent facilitation' },
  { id: 'env-var-name-not-value', text: 'set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your shell profile before running the CLI' },
  { id: 'windows-path-with-colon', text: 'the installer dropped files under C:\\Users\\alex\\AppData\\Local\\Programs\\example' },
  { id: 'two-segment-base64-not-jwt', text: 'the cache key is eyJhbGciOiJIUzI1NiJ9.eyJmb28iOiJiYXIifQ with no third segment at all' },
  { id: 'sku-code-uppercase', text: 'restock SKU-4471209 before the weekend sale goes live' },
  { id: 'phone-number', text: 'reach the on-call at +1-415-555-0134 if the pager does not fire' },
  { id: 'semver-and-package-name', text: 'bump @modelcontextprotocol/sdk to 1.30.0 in the next release' },
  { id: 'markdown-bearer-explanation-prose', text: 'the bearer of good news gets remembered longest, said no engineering handbook ever' },
] as const;
