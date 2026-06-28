const chalk = new Proxy(
  (s: string) => s,
  {
    get(_target, prop) {
      if (prop === 'default' || prop === 'chalk') return chalk;
      if (typeof prop === 'string') return chalk;
      return chalk;
    },
  }
);

export default chalk;
