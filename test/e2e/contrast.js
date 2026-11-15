/**
 * WCAG contrast measured in the page: every visible text node against the
 * background it is really drawn on (the opaque ancestors' colours composited),
 * AA thresholds (4.5:1, 3:1 for large text). Text over images, SVG drawings
 * and the terminals' own canvas is not measured: no background to read
 */
export async function contrastFailures(page, { within = 'body' } = {}) {
  return page.evaluate((root) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/) ?? c.match(/color\(srgb ([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      const scale = c.startsWith('color(') ? 255 : 1;
      return { r: p[0] * scale, g: p[1] * scale, b: p[2] * scale, a: p[3] ?? 1 };
    };
    const over = (top, bottom) => {
      const a = top.a + bottom.a * (1 - top.a);
      const mix = (k) => (top[k] * top.a + bottom[k] * bottom.a * (1 - top.a)) / (a || 1);
      return { r: mix('r'), g: mix('g'), b: mix('b'), a };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
    const backdrop = (el) => {
      const chain = [];
      for (let n = el; n; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.backgroundImage !== 'none') return null;
        const c = parse(s.backgroundColor);
        if (c && c.a > 0) { chain.push(c); if (c.a === 1) break; }
      }
      let acc = { r: 255, g: 255, b: 255, a: 1 };
      for (const c of chain.reverse()) acc = over(c, acc);
      return acc;
    };
    const out = [];
    const walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (!el || el.closest('svg, canvas, .xterm, script, style, [hidden], [disabled], [aria-disabled="true"]')) continue;
      const box = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (!box.width || !box.height || s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 1 || el.closest('[hidden]')) continue;
      const bg = backdrop(el);
      const fg = parse(s.color);
      if (!bg || !fg) continue;
      const text = over(fg, bg);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const got = ratio(text, bg);
      if (got < (large ? 3 : 4.5)) out.push({ text: node.textContent.trim().slice(0, 40), ratio: Math.round(got * 100) / 100, selector: `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}` });
    }
    return out;
  }, within);
}

/** Visible text drawn smaller than `min` px (the floor of the redesign is 12, docs/v2/UX.md §6.2) */
export async function tinyText(page, { within = 'body', min = 12 } = {}) {
  return page.evaluate(([root, floor]) => {
    const out = [];
    const walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!node.textContent.trim() || !el || el.closest('svg, canvas, .xterm, script, style, [hidden]')) continue;
      const box = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (!box.width || !box.height || s.visibility === 'hidden') continue;
      if (parseFloat(s.fontSize) < floor) out.push({ text: node.textContent.trim().slice(0, 30), size: s.fontSize, selector: `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join('.')}` });
    }
    return out;
  }, [within, min]);
}
