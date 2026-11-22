const k6Encoding = {
   b64encode: (str: string, format?: string): string => {
      if (format === 'rawurl') {
         return Buffer.from(str, 'utf8').toString('base64url');
      }
      return Buffer.from(str, 'utf8').toString('base64');
   },
};

export default k6Encoding;
