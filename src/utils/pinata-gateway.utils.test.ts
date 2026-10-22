import {
   normalizeIpfsCid,
   resolvePinataGatewayUrl,
} from './pinata-gateway.utils';

const mockGateway = { url: 'https://gateway.pinata.cloud/ipfs' };

jest.mock('../config', () => ({
   envConfig: {
      get PINATA_GATEWAY_URL() {
         return mockGateway.url;
      },
   },
}));

describe('normalizeIpfsCid', () => {
   it('returns a bare CID unchanged', () => {
      expect(normalizeIpfsCid('bafybeigdyrzt')).toBe('bafybeigdyrzt');
   });

   it('strips the ipfs:// scheme', () => {
      expect(normalizeIpfsCid('ipfs://bafybeigdyrzt')).toBe('bafybeigdyrzt');
   });

   it('extracts the CID from a gateway URL with a file path', () => {
      expect(
         normalizeIpfsCid(
            'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt/avatar.png'
         )
      ).toBe('bafybeigdyrzt');
   });

   it('extracts the CID from an /ipfs/ path fragment', () => {
      expect(normalizeIpfsCid('/ipfs/bafybeigdyrzt?width=100')).toBe(
         'bafybeigdyrzt'
      );
   });

   it('trims surrounding whitespace', () => {
      expect(normalizeIpfsCid('  ipfs://bafybeigdyrzt  ')).toBe(
         'bafybeigdyrzt'
      );
   });

   it('returns null for empty, null, or undefined input', () => {
      expect(normalizeIpfsCid('')).toBeNull();
      expect(normalizeIpfsCid('   ')).toBeNull();
      expect(normalizeIpfsCid(null)).toBeNull();
      expect(normalizeIpfsCid(undefined)).toBeNull();
   });

   it('returns null when only the ipfs prefix is present', () => {
      expect(normalizeIpfsCid('ipfs://')).toBeNull();
   });
});

describe('resolvePinataGatewayUrl', () => {
   beforeEach(() => {
      mockGateway.url = 'https://gateway.pinata.cloud/ipfs';
   });

   it('resolves a bare CID to the default gateway URL', () => {
      expect(resolvePinataGatewayUrl('bafybeigdyrzt')).toBe(
         'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt'
      );
   });

   it('resolves an ipfs:// URI to a gateway URL', () => {
      expect(resolvePinataGatewayUrl('ipfs://bafybeigdyrzt')).toBe(
         'https://gateway.pinata.cloud/ipfs/bafybeigdyrzt'
      );
   });

   it('normalizes trailing slashes on a configured gateway base', () => {
      mockGateway.url = 'https://my-gateway.example/ipfs/';

      expect(resolvePinataGatewayUrl('bafybeigdyrzt')).toBe(
         'https://my-gateway.example/ipfs/bafybeigdyrzt'
      );
   });

   it('returns null when no CID can be extracted', () => {
      expect(resolvePinataGatewayUrl('')).toBeNull();
      expect(resolvePinataGatewayUrl(null)).toBeNull();
      expect(resolvePinataGatewayUrl(undefined)).toBeNull();
   });
});
