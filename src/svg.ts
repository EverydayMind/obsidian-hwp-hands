import DOMPurify from 'dompurify';

const purifiers = new WeakMap<Window, typeof DOMPurify>();
/** Matches an attribute that mentions a CSS function that can fetch a resource; everything else is inert. */
const CSS_RESOURCE_HINT = /url\s*\(|expression\s*\(|@import/i;

function purifierFor(owner: Document): typeof DOMPurify {
  const view = owner.defaultView;
  if (!view || view === window) return DOMPurify;
  let purifier = purifiers.get(view);
  if (!purifier) { purifier = DOMPurify(view); purifiers.set(view, purifier); }
  return purifier;
}

/** Mount a renderer projection while retaining local SVG styling and embedded raster images. */
export function safeSvg(svg: string, owner: Document = document): DocumentFragment {
  const sanitized = purifierFor(owner).sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'script', 'a', 'style'],
    RETURN_DOM_FRAGMENT: true,
  });
  const fragment = sanitized.ownerDocument === owner ? sanitized : owner.adoptNode(sanitized);
  // Walk backwards so removal is safe without allocating an attribute array for every glyph element.
  for (const element of fragment.querySelectorAll('*')) for (let index = element.attributes.length - 1; index >= 0; index--) {
    const attribute = element.attributes[index];
    const { name, value } = attribute;
    if (name === 'href' || name === 'xlink:href') {
      if (!value.startsWith('#') && !/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(value)) element.removeAttribute(name);
    }
    // Path data and coordinates dominate a page SVG and can never hold a CSS resource reference, so skip the costly rewrite for them.
    if (!CSS_RESOURCE_HINT.test(value)) continue;
    // SVG paints may reference local gradients/clip paths; all external CSS resources are removed.
    const stripped = value.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, '');
    if (CSS_RESOURCE_HINT.test(stripped)) element.removeAttribute(name);
  }
  return fragment;
}
