import { envConfig } from '../config';

/**
 * Sensitive key patterns for config value masking.
 *
 * Config keys matching any of these patterns (case-insensitive substring match)
 * will have their values redacted when logged. Add new patterns here when
 * introducing config fields that contain secrets, keys, passwords, or tokens.
 *
 * Current sensitive patterns:
 * - `SECRET`  — matches APP_SECRET, GOOGLE_CLIENT_SECRET, CLOUDINARY_API_SECRET,
 *               PAYSTACK_SECRET_KEY
 * - `KEY`     — matches PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY,
 *               CLOUDINARY_API_KEY
 * - `PASSWORD` — matches GMAIL_APP_PASSWORD
 * - `TOKEN`   — reserved for future token-based config values
 * - `DATABASE_URL` — contains embedded credentials (user:password@host)
 */
const SENSITIVE_KEY_PATTERNS = [
  /SECRET/i,
  /KEY/i,
  /PASSWORD/i,
  /TOKEN/i,
];

const SENSITIVE_EXACT_KEYS = ['DATABASE_URL'];

function isKeySensitive(key: string): boolean {
  if (SENSITIVE_EXACT_KEYS.includes(key)) return true;
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function maskDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    if (parsed.username) {
      parsed.username = parsed.username ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return '***';
  }
}

function maskValue(key: string, value: unknown): unknown {
  if (!isKeySensitive(key)) return value;

  if (typeof value === 'string') {
    if (key === 'DATABASE_URL') {
      return maskDatabaseUrl(value);
    }
    if (value.length > 8) {
      return value.slice(0, 4) + '***' + value.slice(-4);
    }
  }

  return '***';
}

/**
 * Returns a copy of the envConfig object with sensitive values redacted.
 *
 * Non-sensitive config values are returned as-is. Sensitive values are
 * partially masked (first 4 and last 4 characters preserved when the value
 * is a string longer than 8 characters; otherwise fully replaced with `'***'`).
 * DATABASE_URL has its embedded password redacted while preserving the rest of
 * the connection string.
 *
 * @example
 * import { maskSensitiveConfigValues } from './utils/config-mask.utils';
 * logger.info(maskSensitiveConfigValues(), 'Startup configuration summary');
 */
export function maskSensitiveConfigValues(): Record<string, unknown> {
  const masked: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(envConfig)) {
    masked[key] = maskValue(key, value);
  }

  return masked;
}
