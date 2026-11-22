import { resetSanctionedAddressCache, sanctionedAddressMiddleware } from './sanctioned-address.middleware';

describe('sanctioned address middleware', () => {
	afterEach(() => {
		delete process.env.SANCTIONED_ADDRESSES;
		resetSanctionedAddressCache();
		jest.restoreAllMocks();
	});

	it('rejects configured addresses and allows unlisted wallets', async () => {
		process.env.SANCTIONED_ADDRESSES = 'Gblocked';
		const next = jest.fn();
		const status = jest.fn().mockReturnThis();
		const json = jest.fn().mockReturnThis();
		await sanctionedAddressMiddleware({ headers: { 'x-wallet-address': 'gblocked' } } as never, { status, json } as never, next);
		expect(status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();

		resetSanctionedAddressCache();
		await sanctionedAddressMiddleware({ headers: { 'x-wallet-address': 'Gallowed' } } as never, { status, json } as never, next);
		expect(next).toHaveBeenCalledTimes(1);
	});
});
