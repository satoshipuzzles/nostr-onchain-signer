const PREFIX = '[NostrOnchain]';

export const log = {
  info: (tag: string, ...args: unknown[]) => console.info(`${PREFIX}[${tag}]`, ...args),
  warn: (tag: string, ...args: unknown[]) => console.warn(`${PREFIX}[${tag}]`, ...args),
  error: (tag: string, ...args: unknown[]) => console.error(`${PREFIX}[${tag}]`, ...args),
  debug: (tag: string, ...args: unknown[]) => console.debug(`${PREFIX}[${tag}]`, ...args),
};
