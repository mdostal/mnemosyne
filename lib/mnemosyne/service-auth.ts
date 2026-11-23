/**
 * The Authorization header TypeScript callers send to the :8477 service
 * (src/server.mjs). Mirrors src/api-auth.mjs's clientAuthHeader() (PANT-1398):
 * the admin token when this process holds it (it passes both the read gate
 * and the write gate), else the API token from MNEMOSYNE_API_TOKEN or the
 * file named by MNEMOSYNE_API_TOKEN_FILE (the local vault drops it there),
 * else nothing. Read at call time so tests can stub the env per test. Never
 * throws; the service's 401/403 names what is missing.
 */
import { readFileSync } from 'node:fs';

export function mnemosyneAuthHeader(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  let token = (env.MNEMOSYNE_ADMIN_TOKEN || '').trim() || (env.MNEMOSYNE_API_TOKEN || '').trim();
  const file = (env.MNEMOSYNE_API_TOKEN_FILE || '').trim();
  if (!token && file) {
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  return token ? { authorization: `Bearer ${token}` } : {};
}
