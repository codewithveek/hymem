export const appName = 'hymem';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';

/**
 * Where the raw-markdown route lives. `proxy.ts` rewrites both `/docs/x.md`
 * and any request preferring `text/markdown` to this, so every page is
 * readable by an agent at a predictable URL.
 */
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'codewithveek',
  repo: 'hymem',
  branch: 'main',
};
