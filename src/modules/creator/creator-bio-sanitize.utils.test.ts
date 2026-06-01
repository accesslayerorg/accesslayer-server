import { sanitizeBio } from './creator-bio-sanitize.utils';

describe('sanitizeBio', () => {
  it('strips HTML tags from the bio', () => {
    expect(sanitizeBio('Hello <b>world</b>! <p>How are you?</p>')).toBe(
      'Hello world! How are you?'
    );
  });

  it('removes invisible Unicode characters', () => {
    expect(
      sanitizeBio('Hello\u200Bworld\u200D!\uFEFFHow\u200Care you?')
    ).toBe('Helloworld!Howare you?');
  });

  it('normalizes whitespace to single spaces', () => {
    expect(sanitizeBio('Hello   world  !  How   are  you?')).toBe(
      'Hello world ! How are you?'
    );
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeBio('  Hello world!  ')).toBe('Hello world!');
  });

  it('handles all sanitization requirements together', () => {
    expect(
      sanitizeBio(
        '<div>  Hello\u200B <b>world</b>!  \uFEFF How are <i>you</i>?  </div>'
      )
    ).toBe('Hello world! How are you?');
  });
});
