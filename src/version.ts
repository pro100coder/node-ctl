// Set by bun build --define; a run from source has neither.
declare const NODE_CTL_VERSION: string | undefined;
declare const NODE_CTL_SHA: string | undefined;

export const VERSION = typeof NODE_CTL_VERSION === 'string' ? NODE_CTL_VERSION : 'dev';
export const SHA = typeof NODE_CTL_SHA === 'string' ? NODE_CTL_SHA : '';
