import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** scrypt parameters: memory-hard (32 MiB per hash), about 100 ms on a small VM. */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const MAX_MEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...opts, maxmem: MAX_MEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Encodes as `scrypt$N$r$p$salt$hash` (base64url), so parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split('$');
  if (!parts || parts.length !== 6 || parts[0] !== 'scrypt') {
    // Same cost as a real check, so unknown users and unset passwords are not distinguishable by timing.
    await derive(password, randomBytes(16), PARAMS);
    return false;
  }
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  const key = await derive(password, Buffer.from(salt, 'base64url'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Validation message in Dutch, or undefined when the password is acceptable. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Wachtwoord moet minimaal ${MIN_PASSWORD_LENGTH} tekens hebben`;
  }
  if (password.length > 256) return 'Wachtwoord is te lang';
  return undefined;
}
