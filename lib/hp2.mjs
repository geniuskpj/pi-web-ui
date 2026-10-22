/**
 * [vendored 2026-10-22 from ws/boilerplate-htmlparser2 (author prototype) — fetch tool converter]
 * core stripper
 *
 * hp2.mjs — core boilerplate stripper built on htmlparser2 + domutils.
 *
 * Pure API (no fs/network): takes AN HTML STRING, returns { title, markdown,
 * textLength, domain }. A JSON result is just this object; the markdown field
 * is the stripped content.
 *
 * Design (shallow call depth):
 *   strip() -> render(root)  — one recursive tree walk emitting markdown blocks
 *             -> inline()    — inline markdown for headings/paragraphs/list items
 *             -> list()      — <ul>/<ol> with nested-list + inline handling
 *   Chrome detection is token-based: class/id words are hyphen/camel-split, so
 *   'mw-editsection' can match class "mw-editsection" without 'SharedPageLayout'
 *   falsely matching the 'share' hint. keepHints win over dropHints; code-bearing
 *   subtrees (hljs/code-block) are protected and rendered as fences.
 *
 *   import { stripBoilerplate } from './hp2.mjs';
 *   const { markdown } = stripBoilerplate(html, { url: 'https://en.wikipedia.org/wiki/X' });
 *   const { markdown } = stripBoilerplate(html, { domain: 'Wikipedia' });
 */
import { parseDocument } from 'htmlparser2';
import { getText, findAll, existsOne } from 'domutils';
import { DOMAINS, matchDomain, namedDomain } from './hp2-config.mjs';

export { DOMAINS, matchDomain };

// ---- attribute tokenization -------------------------------------------------
const tokens = (el) => new Set(
  [el.attribs?.id, el.attribs?.class, el.attribs?.role].filter(Boolean).join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

// word-wise hint match: 'mw-editsection' matches tokens {mw,editsection}
const hit = (toks, h) => h.toLowerCase().split(/[^a-z0-9]+/).every((w) => toks.has(w));
const anyHit = (toks, hs) => hs.some((h) => hit(toks, h));

const squash = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();

// ---- always-dropped tags + baseline chrome hints -----------------------------
const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'link', 'meta', 'iframe', 'svg', 'canvas',
  'nav', 'header', 'footer', 'aside', 'form', 'button', 'input', 'select', 'textarea',
  'head', 'title', 'dialog',
]);
const CHROME = [
  'nav', 'menu', 'sidebar', 'footer', 'header', 'breadcrumb', 'cookie', 'banner',
  'advert', 'adsense', 'promo', 'subscribe', 'newsletter', 'social', 'share',
  'login', 'signin', 'signup', 'drawer', 'modal', 'popup', 'mw-editsection',
  'mw-jump', 'hatnote', 'catlinks', 'printfooter', 'noprint', 'skip-link',
];

// ---- tiny selector match: tag / .class / #id / tag.class ---------------------
function matchSel(el, sel) {
  if (el.type !== 'tag') return false;
  const toks = tokens(el);
  for (const part of sel.trim().split(/(?=[.#])/)) {
    if (!part) continue;
    if (part.startsWith('.')) { if (!hit(toks, part.slice(1))) return false; }
    else if (part.startsWith('#')) { if (part.slice(1) !== el.attribs?.id) return false; }
    else if (part.toLowerCase() !== el.name.toLowerCase()) return false;
  }
  return true;
}
const findFirst = (root, sel) => findAll((el) => matchSel(el, sel), [root]).at(0) || null;

// ---- public API ---------------------------------------------------------------
export function stripBoilerplate(html, { url = '', domain = '' } = {}) {
  const doc = parseDocument(html);
  const d = (domain && namedDomain(domain)) || matchDomain(url);

  const cfg = {
    dropTags: new Set([...DROP_TAGS, ...(d.dropTags || [])]),
    dropHints: [...CHROME, ...(d.dropHints || [])],
    keepHints: d.keepHints || [],
    codeHints: d.codeHints || ['hljs', 'code-block', 'highlight'],
    shift: d.headingShift || 0,
    stripEdits: !!d.stripHeadings,
  };

  const root = (d.content || []).map((s) => findFirst(doc, s)).find(Boolean)
    || findFirst(doc, 'article') || findFirst(doc, 'main')
    || findFirst(doc, 'body') || doc;

  const markdown = render(root, cfg).filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  const titleNode = findFirst(doc, 'title') || findFirst(doc, 'h1');
  const title = titleNode ? squash(getText(titleNode).slice(0, 200)) : '';

  return { title, markdown, textLength: markdown.length, domain: d.name, blocks: markdown ? markdown.split(/\n\n/).length : 0 };
}

// ---- chrome / code detection ---------------------------------------------------
function hasCode(el, hints) {
  return existsOne((e) => e.type === 'tag' && anyHit(tokens(e), hints), el.children || [el]);
}
function isCodeNode(el, hints) {
  if (el.type !== 'tag') return false;
  const t = el.name.toLowerCase();
  return t === 'pre' || t === 'code' || anyHit(tokens(el), hints) || (t === 'button' && hasCode(el, hints));
}
function isDrop(el, cfg) {
  if (el.type !== 'tag') return false;
  const t = el.name.toLowerCase();
  if (t === 'script' || t === 'style') return true;
  if (cfg.dropTags.has(t)) return !hasCode(el, cfg.codeHints);
  const toks = tokens(el);
  if (anyHit(toks, cfg.keepHints)) return false;
  return anyHit(toks, cfg.dropHints);
}
function isEditLink(el) {
  const href = el.attribs?.href || '';
  return anyHit(tokens(el), ['mw-editsection'])
    || /[?&]action=edit|w\/index\.php\?.*action=edit/.test(href);
}

// raw text of a subtree, skipping script/style (used for fenced code)
function rawText(el) {
  if (el.type === 'text') return el.data;
  if (el.type !== 'tag') return '';
  const t = el.name.toLowerCase();
  if (t === 'script' || t === 'style') return '';
  if (t === 'br') return '\n';
  return (el.children || []).map(rawText).join('');
}

// ---- inline markdown -----------------------------------------------------------
function inline(el, stripEdits) {
  if (stripEdits && isEditLink(el)) return '';
  return (el.children || []).map((c) => {
    if (c.type === 'text') return c.data;
    if (c.type !== 'tag') return '';
    if (stripEdits && isEditLink(c)) return '';
    const t = c.name.toLowerCase();
    const kids = () => inline(c, stripEdits);
    switch (t) {
      case 'br': return ' ';
      case 'a': {
        const s = kids().trim(); const href = c.attribs?.href || '';
        if (!s) return '';
        return href.startsWith('#') ? s : `[${s}](${href})`;
      }
      case 'code': return '`' + squash(getText(c)) + '`';
      case 'em': case 'i': return '*' + kids() + '*';
      case 'strong': case 'b': return '**' + kids() + '**';
      case 'img': return c.attribs?.src ? (c.attribs?.alt || '') : '';
      default: return kids();
    }
  }).join('');
}

// ---- lists ---------------------------------------------------------------------
function list(ul, ordered, cfg, out, depth) {
  let i = 0;
  for (const li of ul.children || []) {
    if (li.type !== 'tag' || li.name.toLowerCase() !== 'li') continue;
    i++;
    const text = [];
    for (const o of li.children || []) {
      if (o.type === 'text') text.push(o.data);
      else if (o.type === 'tag' && ['ul', 'ol'].includes(o.name.toLowerCase())) {
        // nested list is rendered after this item's text
      } else if (o.type === 'tag') text.push(inline(o, cfg.stripEdits));
    }
    out.push('  '.repeat(depth) + (ordered ? `${i}. ` : '- ') + squash(text.join(' ')));
    for (const o of li.children || [])
      if (o.type === 'tag' && ['ul', 'ol'].includes(o.name.toLowerCase()))
        list(o, o.name.toLowerCase() === 'ol', cfg, out, depth + 1);
  }
}

// ---- table ---------------------------------------------------------------------
function table(tbl) {
  const rows = findAll((e) => e.type === 'tag' && e.name.toLowerCase() === 'tr', [tbl]);
  if (!rows.length) return '';
  const cells = (tr) => findAll((e) => e.type === 'tag' && ['th', 'td'].includes(e.name.toLowerCase()), [tr])
    .map((c) => squash(getText(c)));
  const toRow = (cs) => '| ' + cs.join(' | ') + ' |';
  const head = cells(rows[0]);
  const out = head.length ? [toRow(head), toRow(head.map(() => '---'))] : [];
  for (const r of rows.slice(1)) {
    const cs = cells(r);
    if (cs.length) out.push(toRow(cs));
  }
  return out.join('\n');
}

// ---- the single block render loop ----------------------------------------------
function render(node, cfg, out = []) {
  for (const c of node.children || []) {
    if (c.type === 'text') { const t = squash(c.data); if (t) out.push(t); continue; }
    if (c.type !== 'tag' || isDrop(c, cfg)) continue;
    const t = c.name.toLowerCase();

    if (isCodeNode(c, cfg.codeHints)) {
      const code = rawText(c).replace(/\t/g, '  ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (code) out.push('```\n' + code + '\n```');
      continue;
    }
    const m = t.match(/^h([1-6])$/);
    if (m) {
      const text = squash(inline(c, cfg.stripEdits));
      if (text) out.push('#'.repeat(Math.min(6, Number(m[1]) + cfg.shift)) + ' ' + text);
    } else if (t === 'p') {
      const text = squash(inline(c, cfg.stripEdits));
      if (text) out.push(text);
    } else if (t === 'ul' || t === 'ol') {
      list(c, t === 'ol', cfg, out, 0);
    } else if (t === 'blockquote') {
      const inner = render(c, cfg);
      if (inner.length) out.push(inner.flatMap((b) => b.split('\n').map((l) => '> ' + l)).join('\n'));
    } else if (t === 'table') {
      const md = table(c); if (md) out.push(md);
    } else if (t === 'img') {
      const src = c.attribs?.src || '';
      if (src) out.push(`![${c.attribs?.alt || ''}](${src})`);
    } else if (t === 'hr') {
      out.push('---');
    } else if (t === 'a') {
      const s = squash(inline(c, cfg.stripEdits));
      const href = c.attribs?.href || '';
      if (s) out.push(href.startsWith('#') ? s : `[${s}](${href})`);
    } else {
      render(c, cfg, out); // containers/unknown: recurse
    }
  }
  return out;
}