import { validationError } from '../middlewares/error.middleware';

const POSITIVE_INTEGER_RE = /^\d+$/;

export function parseCreatorId(raw: string): number {
  if (!raw || typeof raw !== 'string') {
    throw validationError('Creator ID is required');
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw validationError('Creator ID is required');
  }

  if (!POSITIVE_INTEGER_RE.test(trimmed)) {
    throw validationError('Creator ID must be a positive integer');
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (parsed <= 0 || !Number.isFinite(parsed)) {
    throw validationError('Creator ID must be a positive integer');
  }

  return parsed;
}
