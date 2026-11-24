import { isSafeProofUrl, ProofCheckService, ProofProviderClient } from './proof-check.service';

const CODE = 'AL-VERIFY-ABC123DEF456';

function fakeClient(pages: Record<string, string | Error>): ProofProviderClient & { fetchPage: jest.Mock } {
   return {
      fetchPage: jest.fn(async (url: string) => {
         const page = pages[url];
         if (page instanceof Error) throw page;
         if (page === undefined) throw new Error('unexpected fetch');
         return page;
      }),
   };
}

const clients = (client: ProofProviderClient) => ({ twitter: client, github: client, website: client });

describe('isSafeProofUrl', () => {
   it('accepts public HTTPS pages on the expected provider host', () => {
      expect(isSafeProofUrl('twitter', 'https://x.com/ada')).toBe(true);
      expect(isSafeProofUrl('twitter', 'https://www.twitter.com/ada')).toBe(true);
      expect(isSafeProofUrl('github', 'https://github.com/ada')).toBe(true);
      expect(isSafeProofUrl('website', 'https://ada.example.com/about')).toBe(true);
   });

   it('refuses a provider link on the wrong host', () => {
      expect(isSafeProofUrl('github', 'https://gitlab.com/ada')).toBe(false);
      expect(isSafeProofUrl('twitter', 'https://github.com/ada')).toBe(false);
   });

   it('refuses anything that is not a public HTTPS URL', () => {
      expect(isSafeProofUrl('website', 'http://ada.example.com')).toBe(false);
      expect(isSafeProofUrl('website', 'https://localhost/admin')).toBe(false);
      expect(isSafeProofUrl('website', 'https://169.254.169.254/latest/meta-data')).toBe(false);
      expect(isSafeProofUrl('website', 'https://[::1]/')).toBe(false);
      expect(isSafeProofUrl('website', 'https://ada.internal/secret')).toBe(false);
      expect(isSafeProofUrl('website', 'https://user:pass@ada.example.com')).toBe(false);
      expect(isSafeProofUrl('website', 'https://ada.example.com:8443/')).toBe(false);
      expect(isSafeProofUrl('website', 'not a url')).toBe(false);
   });
});

describe('ProofCheckService.verify', () => {
   const proof = (id: string, provider: 'github' | 'website', url: string) => ({ id, provider, url });

   it('passes only when every linked account shows the proof code', async () => {
      const client = fakeClient({
         'https://github.com/ada': `bio: ${CODE}`,
         'https://ada.example.com/': 'no code here',
      });
      const checker = new ProofCheckService(clients(client));

      const result = await checker.verify({
         proofCode: CODE,
         proofs: [
            proof('p1', 'github', 'https://github.com/ada'),
            proof('p2', 'website', 'https://ada.example.com/'),
         ],
      });

      expect(result.passed).toBe(false);
      expect(result.results).toEqual([
         { proofId: 'p1', passed: true, failureReason: null },
         { proofId: 'p2', passed: false, failureReason: 'Proof code was not found on this page' },
      ]);
   });

   it('passes when all linked accounts contain the code', async () => {
      const client = fakeClient({
         'https://github.com/ada': CODE,
         'https://ada.example.com/': `<p>${CODE}</p>`,
      });
      const result = await new ProofCheckService(clients(client)).verify({
         proofCode: CODE,
         proofs: [
            proof('p1', 'github', 'https://github.com/ada'),
            proof('p2', 'website', 'https://ada.example.com/'),
         ],
      });
      expect(result.passed).toBe(true);
   });

   it('never fetches an unsafe link', async () => {
      const client = fakeClient({});
      const result = await new ProofCheckService(clients(client)).verify({
         proofCode: CODE,
         proofs: [proof('p1', 'website', 'http://10.0.0.5/admin')],
      });

      expect(client.fetchPage).not.toHaveBeenCalled();
      expect(result.passed).toBe(false);
      expect(result.results[0].failureReason).toMatch(/not a public HTTPS page/);
   });

   it('fails a link that cannot be loaded, with a generic reason', async () => {
      const client = fakeClient({ 'https://github.com/ada': new Error('HTTP 503') });
      const result = await new ProofCheckService(clients(client)).verify({
         proofCode: CODE,
         proofs: [proof('p1', 'github', 'https://github.com/ada')],
      });
      expect(result.passed).toBe(false);
      expect(result.results[0]).toEqual({
         proofId: 'p1',
         passed: false,
         failureReason: 'The page could not be loaded',
      });
   });

   it('does not pass an application with no links', async () => {
      const result = await new ProofCheckService(clients(fakeClient({}))).verify({
         proofCode: CODE,
         proofs: [],
      });
      expect(result.passed).toBe(false);
   });
});
