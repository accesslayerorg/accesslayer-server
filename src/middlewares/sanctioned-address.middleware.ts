import { Request, Response, NextFunction } from 'express';
import { ErrorCode, sendError } from '../utils/api-response.utils';

const REFRESH_MS = 5 * 60 * 1000;
let cachedAddresses = new Set<string>();
let refreshedAt = 0;
let refreshPromise: Promise<Set<string>> | null = null;

function configuredAddresses(): Set<string> {
	return new Set((process.env.SANCTIONED_ADDRESSES ?? '').split(',').map(address => address.trim().toUpperCase()).filter(Boolean));
}

async function refreshBlocklist(): Promise<Set<string>> {
	const configured = configuredAddresses();
	const url = process.env.SANCTIONED_BLOCKLIST_URL;
	if (!url) return configured;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
		if (!response.ok) return configured;
		const payload: unknown = await response.json();
		const remote = Array.isArray(payload)
			? payload
			: payload && typeof payload === 'object' && Array.isArray((payload as { addresses?: unknown }).addresses)
				? (payload as { addresses: unknown[] }).addresses
				: [];
		return new Set([...configured, ...remote.filter((address): address is string => typeof address === 'string').map(address => address.trim().toUpperCase())]);
	} catch {
		return configured;
	}
}

async function getBlocklist(): Promise<Set<string>> {
	if (Date.now() - refreshedAt < REFRESH_MS) return cachedAddresses;
	if (!refreshPromise) {
		refreshPromise = refreshBlocklist().then(addresses => {
			cachedAddresses = addresses;
			refreshedAt = Date.now();
			return addresses;
		}).finally(() => { refreshPromise = null; });
	}
	return refreshPromise;
}

export async function sanctionedAddressMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
	const address = String(req.headers['x-wallet-address'] ?? '').trim().toUpperCase();
	if (!address) {
		next();
		return;
	}
	if ((await getBlocklist()).has(address)) {
		sendError(res, 403, ErrorCode.FORBIDDEN, 'This wallet is not permitted to access the requested resource.');
		return;
	}
	next();
}

export function resetSanctionedAddressCache(): void {
	cachedAddresses = new Set();
	refreshedAt = 0;
}
