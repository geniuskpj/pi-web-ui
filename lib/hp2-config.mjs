/**
 * [vendored 2026-10-22 from ws/boilerplate-htmlparser2 (author prototype) — fetch tool converter]
 * domain rules
 *
 * config.mjs — per-domain boilerplate stripping rules for hp2.mjs.
 *
 * Each entry selects a domain config by `host` (exact hostname) or `match`
 * (regex against the full URL). The first match wins; 'Generic' is the fallback.
 *
 * Fields (all optional unless noted):
 *   name        label (also usable as --domain <name>)
 *   host        exact hostname, e.g. 'en.wikipedia.org'
 *   match       RegExp tested against the full URL
 *   content     ordered selector list (tag / .class / #id / tag.class); the
 *               first element found becomes the extraction root
 *   dropHints   class/id word-tokens marking a chrome subtree to drop;
 *               compound tokens like 'mw-editsection' match word-wise
 *   keepHints   tokens that PROTECT a subtree from dropping (whitelist wins)
 *   codeHints   tokens marking inline code (highlight.js 'hljs', 'code-block');
 *               subtrees containing code are never dropped, and matched code
 *               containers render as ``` fenced blocks.
 *   headingShift  add N to every heading level (wikipedia: 1 converts h1->h2)
 *   stripHeadings drop '[edit source]/' mw-editsection links inside headings
 */
export const DOMAINS = [
  {
    name: 'Hugging Face docs',
    match: /huggingface\.co\/docs\//,
    content: ['main.doc-article', 'div.prose-doc', '.prose', 'article', 'main'],
    dropHints: ['docbuilder', 'sidenav', 'contents', 'prev', 'next', 'navigation', 'pagination'],
    keepHints: ['prose', 'doc-article', 'markdown', 'content'],
  },
  {
    name: 'Hugging Face task page',
    match: /huggingface\.co\/tasks\//,
    content: ['div.prose-doc', '.prose', 'main', 'article'],
    dropHints: ['sidenav'],
    keepHints: ['prose', 'content', 'main'],
  },
  {
    name: 'GitHub',
    host: 'github.com',
    content: ['article.markdown-body', '.markdown-body', 'div.repository-content', 'main', 'article'],
    dropHints: ['pagehead', 'breadcrumb', 'commit', 'blobnav', 'file-navigation', 'stale', 'flash', 'consent'],
    keepHints: ['markdown-body', 'repository-content', 'blobview', 'codeview', 'react-app'],
  },
  {
    name: 'Wikipedia',
    host: 'en.wikipedia.org',
    match: /wikipedia\.org\/wiki\//,
    content: ['div#content', '#bodyContent', 'div.mw-parser-output', '#mw-content-text', 'article', 'main'],
    dropHints: ['catlinks', 'printfooter', 'navbox', 'metadata', 'mw-editsection', 'mw-jump', 'hatnote', 'dablink', 'shortdescription', 'infobox', 'thumbinner'],
    keepHints: ['mw-parser-output', 'mw-content-text', 'bodycontent'],
    stripHeadings: true,
    headingShift: 1,
  },
  {
    name: 'MDN Web Docs',
    host: 'developer.mozilla.org',
    content: ['article.main-page-content', '.main-content', 'article', 'main'],
    dropHints: ['prevnext', 'on-this-page', 'metadata', 'locale', 'privacy'],
    keepHints: ['main-page-content', 'section-content', 'document-toc'],
  },
  {
    name: 'Docusaurus',
    host: 'docusaurus.io',
    content: ['article#__docusaurus', 'article', 'article.theme-doc-markdown', '.theme-doc-markdown', 'main'],
    dropHints: ['breadcrumbs', 'docsidebar', 'table-of-contents', 'pagination-nav', 'theme-edit-this-page', 'theme-last-updated'],
    keepHints: ['theme-doc-markdown', 'markdown', 'docitem'],
  },
  {
    name: 'Generic',
    content: ['article', 'main', 'div#content', 'body'],
    dropHints: [],
    keepHints: ['content', 'article', 'post', 'entry', 'main'],
  },
];

/** Resolve the config for a URL (exact host first, then regex match). */
export function matchDomain(url = '') {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url).toLowerCase(); }
  return DOMAINS.find((d) => d.host && d.host === host)
      || DOMAINS.find((d) => d.match && d.match.test(url))
      || DOMAINS[DOMAINS.length - 1];
}

/** Resolve by domain name (returns undefined if unknown). */
export function namedDomain(name) {
  return DOMAINS.find((d) => d.name === name);
}