import { normalizeSocialLinkUrl } from './creator-social-link-url.utils';

describe('normalizeSocialLinkUrl', () => {
  it('removes trailing slashes from the path', () => {
    expect(normalizeSocialLinkUrl('https://example.com/alice/')).toBe(
      'https://example.com/alice'
    );
  });

  it('lowercases the host component', () => {
    expect(normalizeSocialLinkUrl('https://Twitter.com/Alice')).toBe(
      'https://twitter.com/Alice'
    );
  });

  it('strips tracking query parameters', () => {
    expect(
      normalizeSocialLinkUrl(
        'https://example.com/alice?utm_source=twitter&utm_medium=social&page=1'
      )
    ).toBe('https://example.com/alice?page=1');
  });

  it('preserves the root path slash', () => {
    expect(normalizeSocialLinkUrl('https://Example.com/')).toBe(
      'https://example.com/'
    );
  });
});
