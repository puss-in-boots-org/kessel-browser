// Reader mode's first half (tools.rs, reader_open): run in the page, it
// finds the article -- the block with the most paragraph text -- and hands
// back a copy of it, with links and pictures made absolute. The second half,
// reader.js, keeps only safe tags and attributes before showing it.
(function () {
  var doc = document;
  var DROP = 'script,style,noscript,template,iframe,form,button,input,select,textarea,nav,aside,footer,header,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.share,.social,.comments,#comments,.advert,.ad,.ads,.newsletter,.related,.cookie';

  function textLength(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().length;
  }

  // Each paragraph's text counts for its parent, and half for the grandparent.
  var scores = new Map();
  var paragraphs = doc.querySelectorAll('p, pre, blockquote, li');
  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i];
    var len = textLength(p);
    if (len < 40) continue;
    var bonus = Math.min(len, 600) + (p.textContent.match(/[,.]/g) || []).length * 10;
    var parent = p.parentElement;
    if (parent) scores.set(parent, (scores.get(parent) || 0) + bonus);
    if (parent && parent.parentElement) scores.set(parent.parentElement, (scores.get(parent.parentElement) || 0) + bonus / 2);
  }
  var best = doc.querySelector('article, [itemprop=articleBody], main, [role=main]');
  var bestScore = best ? (scores.get(best) || 0) * 1.2 : 0;
  scores.forEach(function (score, el) {
    // Link-heavy blocks are menus, not articles.
    var links = 0;
    var as = el.querySelectorAll('a');
    for (var j = 0; j < as.length; j++) links += textLength(as[j]);
    var density = links / Math.max(1, textLength(el));
    var s = score * (1 - Math.min(0.9, density));
    if (s > bestScore) {
      bestScore = s;
      best = el;
    }
  });
  if (!best) return null;

  var copy = best.cloneNode(true);
  var junk = copy.querySelectorAll(DROP);
  for (var k = 0; k < junk.length; k++) junk[k].remove();
  var media = copy.querySelectorAll('a[href], img');
  for (var m = 0; m < media.length; m++) {
    var el = media[m];
    if (el.tagName === 'A') el.setAttribute('href', el.href);
    else {
      var src = el.currentSrc || el.src || el.getAttribute('data-src') || '';
      if (src) el.setAttribute('src', new URL(src, location.href).href);
    }
  }

  function meta(name) {
    var tag = doc.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return tag ? (tag.getAttribute('content') || '').trim() : '';
  }
  var h1 = doc.querySelector('h1');
  var title = meta('og:title') || (h1 && h1.textContent.trim()) || doc.title;
  return {
    title: title.slice(0, 300),
    byline: (meta('author') || meta('article:author')).slice(0, 200),
    site: (meta('og:site_name') || location.hostname.replace(/^www\./, '')).slice(0, 100),
    published: meta('article:published_time').slice(0, 40),
    lang: doc.documentElement.lang || '',
    dir: doc.dir || '',
    html: copy.innerHTML.slice(0, 2000000),
    words: textLength(copy) / 5 | 0
  };
})()
