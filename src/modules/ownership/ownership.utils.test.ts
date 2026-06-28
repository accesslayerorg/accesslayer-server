import { calculateTotalPortfolioValue, HoldingEntry } from './ownership.utils';

describe('calculateTotalPortfolioValue', () => {
    it('returns correct sum for a single holding', () => {
        const entries: HoldingEntry[] = [
            { balance: '100', currentPrice: '5.50' },
        ];
        expect(calculateTotalPortfolioValue(entries)).toBe('550');
    });

    it('returns correct sum for multiple holdings', () => {
        const entries: HoldingEntry[] = [
            { balance: '100', currentPrice: '5.50' },
            { balance: '200', currentPrice: '10.00' },
            { balance: '50', currentPrice: '2.00' },
        ];
        expect(calculateTotalPortfolioValue(entries)).toBe('2650');
    });

    it('returns zero when all prices are zero', () => {
        const entries: HoldingEntry[] = [
            { balance: '100', currentPrice: '0' },
            { balance: '200', currentPrice: '0' },
        ];
        expect(calculateTotalPortfolioValue(entries)).toBe('0');
    });

    it('returns zero when all balances are zero', () => {
        const entries: HoldingEntry[] = [
            { balance: '0', currentPrice: '5.50' },
            { balance: '0', currentPrice: '10.00' },
        ];
        expect(calculateTotalPortfolioValue(entries)).toBe('0');
    });

    it('returns zero for an empty array', () => {
        expect(calculateTotalPortfolioValue([])).toBe('0');
    });
});
