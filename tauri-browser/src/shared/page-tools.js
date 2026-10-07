  // --- Page tools (src-tauri/src/tools.rs) ---
  // Inside Kessel's page script (adblock.rs), which gives it BRIDGE and
  // `later`: this site's tweaks (your CSS, a page filter, elements you hid,
  // auto-reload, De-AMP), mouse gestures, picking an element to hide, and
  // opening links from the keyboard.
  (function () {
    var tweaks = { gestures: true };
    var style = null;
    var reloadTimer = null;

    var FILTERS = {
      grayscale: 'html{filter:grayscale(1)!important}',
      sepia: 'html{filter:sepia(.8)!important}',
      invert: 'html{filter:invert(1) hue-rotate(180deg)!important}',
      contrast: 'html{filter:contrast(1.35)!important}',
      dim: 'html{filter:brightness(.8)!important}',
      // Dark: the page inverted, pictures and videos turned back.
      dark: 'html{filter:invert(.92) hue-rotate(180deg)!important;background:#fff!important}' +
        'img,video,picture,canvas,iframe,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}'
    };

    function mount(el) {
      var parent = document.head || document.documentElement;
      if (parent) parent.appendChild(el);
      else document.addEventListener('DOMContentLoaded', function () { mount(el); });
    }

    function apply(t) {
      tweaks = t || tweaks;
      if (!style) {
        style = document.createElement('style');
        style.setAttribute('data-kessel', 'tweaks');
        mount(style);
      }
      var css = '';
      var zapped = tweaks.zapped || [];
      // One rule per selector: one the engine can't read can't void the others.
      for (var i = 0; i < zapped.length; i++) css += zapped[i] + '{display:none!important}\n';
      if (FILTERS[tweaks.filter]) css += FILTERS[tweaks.filter] + '\n';
      // Settings -> Accessibility (a11y.rs): where the keyboard is, always
      // clear; animations and transitions cut short.
      var a11y = tweaks.a11y || {};
      if (a11y.focus_rings) css += ':focus-visible{outline:3px solid #1a73e8!important;outline-offset:2px!important;box-shadow:0 0 0 5px rgba(255,255,255,.9)!important}\n';
      if (a11y.still) css += '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important;scroll-behavior:auto!important}\n';
      // Subtitles the way you can read them (a11y.rs picked the values).
      var cue = a11y.captions;
      if (cue) css += '::cue{' + (cue.size ? 'font-size:' + cue.size + '%!important;' : '') + (cue.color ? 'color:' + cue.color + '!important;' : '') + (cue.background ? 'background-color:' + cue.background + '!important;' : '') + '}\n';
      if (tweaks.css) css += tweaks.css + '\n';
      style.textContent = css;
      minimumFont(+a11y.min_font || 0);
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = null;
      var every = +tweaks.reload || 0;
      if (every >= 5) reloadTimer = later(function () { location.reload(); }, every * 1000);
      if (tweaks.deamp) deAmp();
      if (tweaks.wayback) offerWayback();
    }

    // Settings -> Accessibility: no text smaller than `size` px -- an element
    // whose own text is smaller gets that size (once each; new ones as
    // they come).
    var minSize = 0, minObserver = null, minDone = new WeakMap();
    function minimumFont(size) {
      minSize = size;
      if (!size) {
        if (minObserver) minObserver.disconnect();
        minObserver = null;
        return;
      }
      function fix(root) {
        if (!root || root.nodeType !== 1) return;
        var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (minDone.get(el) === minSize) continue;
          minDone.set(el, minSize);
          var text = false;
          for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && n.nodeValue.trim()) { text = true; break; }
          if (!text) continue;
          var px = parseFloat(getComputedStyle(el).fontSize);
          if (px && px < minSize) el.style.setProperty('font-size', minSize + 'px', 'important');
        }
      }
      function start() {
        fix(document.body);
        if (minObserver) return;
        minObserver = new MutationObserver(function (records) {
          for (var r = 0; r < records.length; r++) {
            var added = records[r].addedNodes;
            for (var j = 0; j < added.length; j++) fix(added[j].nodeType === 3 ? added[j].parentElement : added[j]);
          }
        });
        minObserver.observe(document.documentElement, { childList: true, subtree: true });
      }
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
    }

    // A page that's gone (404, 410): offer the Wayback Machine's copy.
    var waybackShown = false;
    function offerWayback() {
      if (waybackShown || window.top !== window || !/^https?:/.test(location.protocol)) return;
      function check() {
        var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        var status = nav && nav.responseStatus;
        if (status !== 404 && status !== 410) return;
        waybackShown = true;
        var bar = document.createElement('div');
        bar.style.cssText = 'position:fixed;z-index:2147483646;left:50%;bottom:18px;transform:translateX(-50%);display:flex;gap:12px;align-items:center;background:#16171d;color:#fff;font:13px system-ui,sans-serif;padding:10px 14px;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.45)';
        var text = document.createElement('span');
        text.textContent = 'This page is gone (' + status + '). Look for a saved copy?';
        var go = document.createElement('a');
        go.textContent = 'Wayback Machine';
        go.href = 'https://web.archive.org/web/2/' + location.href;
        go.style.cssText = 'color:#8ab4ff;font-weight:600;text-decoration:none';
        var x = document.createElement('button');
        x.textContent = '✕';
        x.title = 'Close';
        x.style.cssText = 'background:none;border:none;color:#aaa;cursor:pointer;font:14px system-ui';
        x.addEventListener('click', function () { bar.remove(); });
        bar.appendChild(text);
        bar.appendChild(go);
        bar.appendChild(x);
        document.documentElement.appendChild(bar);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
      else check();
    }

    // An AMP copy of a page (html[amp] / html[⚡]) goes to the real one.
    function deAmp() {
      function check() {
        var root = document.documentElement;
        if (!root || !(root.hasAttribute('amp') || root.hasAttribute('⚡'))) return;
        var link = document.querySelector('link[rel="canonical"]');
        var to = link && link.href;
        if (to && /^https?:/.test(to) && to !== location.href) location.replace(to);
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check);
      else check();
    }

    // --- Your site settings (permissions.rs) the page itself keeps ---
    // Full screen turned off for the site: a request for it is turned down
    // (a player in another site's frame: main.rs page_fullscreen).
    var fullscreenAllowed = true;
    ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen'].forEach(function (name) {
      var original = Element.prototype[name];
      if (!original) return;
      Element.prototype[name] = function () {
        if (fullscreenAllowed) return original.apply(this, arguments);
        return name === 'requestFullscreen' ? Promise.reject(new TypeError('Full screen is turned off for this site')) : undefined;
      };
    });
    // Sound playing on its own turned off for the site: a video or sound
    // can't start before you've done anything on the page -- play() is
    // turned down, and one starting by itself (autoplay) is paused.
    var autoplayAllowed = true;
    var interacted = function () { return !!(navigator.userActivation && navigator.userActivation.hasBeenActive); };
    var nativePlay = HTMLMediaElement.prototype.play;
    // (Until the site's settings are here, a play() waits for them.)
    var settingsKnown = false;
    var settingsReady = null;
    HTMLMediaElement.prototype.play = function () {
      var media = this, args = arguments;
      if (!settingsKnown && settingsReady) return settingsReady.then(function () { return HTMLMediaElement.prototype.play.apply(media, args); });
      if (!autoplayAllowed && !interacted()) return Promise.reject(new DOMException('Sound playing on its own is turned off for this site', 'NotAllowedError'));
      return nativePlay.apply(this, arguments);
    };
    document.addEventListener('play', function (e) {
      if (!autoplayAllowed && !interacted() && e.target && e.target.pause) e.target.pause();
    }, true);
    function siteSettings(t) {
      fullscreenAllowed = !t || t.fullscreen !== false;
      autoplayAllowed = !t || t.autoplay !== false;
      if (!fullscreenAllowed && document.fullscreenElement) document.exitFullscreen();
      // What started before they were here.
      if (!autoplayAllowed && !interacted()) {
        Array.prototype.forEach.call(document.querySelectorAll('video, audio'), function (m) { if (!m.paused) m.pause(); });
      }
    }
    // Pop-ups: a window.open without a click is one the engine's pop-up
    // blocker stops anyway -- Kessel hears of it instead, and opens it as a
    // tab if you allow the site's pop-ups, or says one was blocked.
    if (window.top === window) {
      var nativeOpen = window.open;
      window.open = function (url) {
        var activation = navigator.userActivation;
        if (!activation || activation.isActive) return nativeOpen.apply(this, arguments);
        var to = '';
        try { to = String(new URL(url, location.href)); } catch (e) {}
        if (/^https?:/.test(to)) BRIDGE.send('popup', { url: to });
        return null;
      };
    }

    function tweaksArrived(t) {
      apply(t);
      siteSettings(t);
    }
    // (Only the page itself hears back: a frame's play() never waits.)
    var tweaks = BRIDGE.request('site-tweaks').then(tweaksArrived, function () {});
    if (window.top === window) settingsReady = tweaks.then(function () { settingsKnown = true; });
    else settingsKnown = true;
    BRIDGE.on('tweaks-changed', function () { BRIDGE.request('site-tweaks').then(tweaksArrived); });

    // --- Mouse gestures: hold the right button and draw ---
    var trail = null;
    var suppressMenu = false;
    function direction(dx, dy) {
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
    }
    window.addEventListener('mousedown', function (e) {
      if (e.button === 2 && tweaks.gestures) trail = { x: e.clientX, y: e.clientY, moves: '' };
    }, true);
    window.addEventListener('mousemove', function (e) {
      if (!trail || !(e.buttons & 2)) return;
      var dx = e.clientX - trail.x, dy = e.clientY - trail.y;
      if (Math.abs(dx) < 30 && Math.abs(dy) < 30) return;
      var d = direction(dx, dy);
      if (trail.moves.charAt(trail.moves.length - 1) !== d) trail.moves += d;
      trail.x = e.clientX;
      trail.y = e.clientY;
    }, true);
    window.addEventListener('mouseup', function (e) {
      if (e.button !== 2 || !trail) return;
      var g = trail.moves;
      trail = null;
      if (g && g.length <= 4) {
        suppressMenu = true;
        BRIDGE.send('gesture', { g: g });
      }
    }, true);
    window.addEventListener('contextmenu', function (e) {
      if (suppressMenu) {
        suppressMenu = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);

    // --- Hide an element: hover to pick, click to hide it for good ---
    function selectorFor(el) {
      if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
      var parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement && parts.length < 5) {
        var part = el.tagName.toLowerCase();
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
          parts.unshift('#' + el.id);
          break;
        }
        var classes = [];
        for (var i = 0; i < el.classList.length && classes.length < 2; i++) {
          if (/^[A-Za-z_][\w-]*$/.test(el.classList[i])) classes.push('.' + el.classList[i]);
        }
        part += classes.join('');
        var parent = el.parentElement;
        if (parent) {
          var same = 0, index = 0;
          for (var j = 0; j < parent.children.length; j++) {
            if (parent.children[j].tagName === el.tagName) {
              same++;
              if (parent.children[j] === el) index = same;
            }
          }
          if (same > 1) part += ':nth-of-type(' + index + ')';
        }
        parts.unshift(part);
        el = parent;
      }
      return parts.join(' > ');
    }

    BRIDGE.on('zap-start', function () {
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #ff5c73;background:rgba(255,92,115,.18);border-radius:3px;transition:all .06s';
      var tip = document.createElement('div');
      tip.textContent = 'Click what to hide on this site · Esc to stop';
      tip.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:12px;transform:translateX(-50%);background:#16171d;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.4);pointer-events:none';
      document.documentElement.appendChild(box);
      document.documentElement.appendChild(tip);
      var target = null;
      function move(e) {
        target = e.target;
        if (!target || target === document.documentElement || target === document.body) return;
        var r = target.getBoundingClientRect();
        box.style.left = r.left + 'px';
        box.style.top = r.top + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
      }
      function stop() {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('click', click, true);
        window.removeEventListener('keydown', key, true);
        box.remove();
        tip.remove();
      }
      function click(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (target && target !== document.documentElement && target !== document.body) {
          var selector = selectorFor(target);
          target.style.setProperty('display', 'none', 'important');
          BRIDGE.send('zap', { selector: selector });
        }
        // Shift+click: keep picking.
        if (!e.shiftKey) stop();
      }
      function key(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          stop();
        }
      }
      window.addEventListener('mousemove', move, true);
      window.addEventListener('click', click, true);
      window.addEventListener('keydown', key, true);
    });

    // --- Link hints: a label on every link; type it to open the link ---
    BRIDGE.on('link-hints', function () {
      var links = [];
      var all = document.querySelectorAll('a[href], button, [role="link"], [role="button"], input[type="submit"], summary');
      for (var i = 0; i < all.length && links.length < 400; i++) {
        var r = all[i].getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
        links.push({ el: all[i], r: r });
      }
      if (!links.length) return;
      var letters = 'asdfghjklqwertyuiopzxcvbnm';
      var width = links.length <= letters.length ? 1 : 2;
      var layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      var labels = [];
      for (var k = 0; k < links.length; k++) {
        var code = width === 1 ? letters[k] : letters[Math.floor(k / letters.length) % letters.length] + letters[k % letters.length];
        var tag = document.createElement('span');
        tag.textContent = code.toUpperCase();
        tag.style.cssText = 'position:fixed;left:' + Math.max(0, links[k].r.left) + 'px;top:' + Math.max(0, links[k].r.top) +
          'px;background:#ffd84d;color:#111;font:bold 11px/1 ui-monospace,monospace;padding:2px 4px;border-radius:3px;border:1px solid #b8960b;box-shadow:0 1px 3px rgba(0,0,0,.3)';
        layer.appendChild(tag);
        labels.push({ code: code, tag: tag, el: links[k].el });
      }
      document.documentElement.appendChild(layer);
      var typed = '';
      function stop() {
        window.removeEventListener('keydown', key, true);
        layer.remove();
      }
      function key(e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') return stop();
        if (e.key === 'Backspace') typed = typed.slice(0, -1);
        else if (e.key.length === 1) typed += e.key.toLowerCase();
        var left = 0, hit = null;
        for (var n = 0; n < labels.length; n++) {
          var match = labels[n].code.indexOf(typed) === 0;
          labels[n].tag.style.display = match ? '' : 'none';
          if (match) left++;
          if (labels[n].code === typed) hit = labels[n];
        }
        if (hit) {
          stop();
          var href = hit.el.href;
          // Shift: in a new tab, like Ctrl+click.
          if (e.shiftKey && href) BRIDGE.send('link', { url: href, ctrl: true, shift: false, button: 0 });
          else if (hit.el.focus) {
            hit.el.focus();
            hit.el.click();
          }
        } else if (!left) {
          stop();
        }
      }
      window.addEventListener('keydown', key, true);
    });

    // --- Screenshot of a part of the page: drag a box ---
    BRIDGE.on('shot-area-start', function () {
      var layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.25)';
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);background:rgba(255,255,255,.08);display:none';
      var tip = document.createElement('div');
      tip.textContent = 'Drag over what to capture · Esc to stop';
      tip.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#16171d;color:#fff;font:13px system-ui,sans-serif;padding:8px 14px;border-radius:10px;pointer-events:none';
      layer.appendChild(box);
      layer.appendChild(tip);
      document.documentElement.appendChild(layer);
      var start = null;
      function rect(e) {
        var x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
        return { x: x, y: y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
      }
      function stop() {
        window.removeEventListener('keydown', key, true);
        layer.remove();
      }
      function key(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          stop();
        }
      }
      layer.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        start = { x: e.clientX, y: e.clientY };
        tip.style.display = 'none';
      });
      layer.addEventListener('mousemove', function (e) {
        if (!start) return;
        var r = rect(e);
        box.style.display = 'block';
        box.style.left = r.x + 'px';
        box.style.top = r.y + 'px';
        box.style.width = r.width + 'px';
        box.style.height = r.height + 'px';
      });
      layer.addEventListener('mouseup', function (e) {
        if (!start) return;
        var r = rect(e);
        stop();
        if (r.width < 4 || r.height < 4) return;
        // On the page, not the window: the page may be scrolled.
        var sx = window.scrollX, sy = window.scrollY;
        // The overlay has to be gone from the picture first.
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            BRIDGE.send('shot-area', { x: r.x + sx, y: r.y + sy, width: r.width, height: r.height });
          });
        });
      });
      window.addEventListener('keydown', key, true);
    });

    // --- Pause everything (break mode): every video and sound here stops ---
    BRIDGE.on('pause-media', function () {
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) {
        try { media[i].pause(); } catch (e) {}
      }
    });

    // --- Theater mode: the page's biggest video fills the tab, on black;
    // again (or Esc) puts it back ---
    var theater = null;
    function endTheater() {
      if (!theater) return;
      if (theater.style === null) theater.video.removeAttribute('style');
      else theater.video.setAttribute('style', theater.style);
      theater.backdrop.remove();
      window.removeEventListener('keydown', theaterKey, true);
      theater = null;
    }
    function theaterKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      endTheater();
    }
    BRIDGE.on('theater', function () {
      if (theater) return endTheater();
      var best = null, bestArea = 0;
      var videos = document.querySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var r = videos[i].getBoundingClientRect();
        if (r.width * r.height > bestArea) { best = videos[i]; bestArea = r.width * r.height; }
      }
      if (!best) return;
      var backdrop = document.createElement('div');
      backdrop.setAttribute('data-kessel', 'theater');
      backdrop.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646';
      document.documentElement.appendChild(backdrop);
      theater = { video: best, style: best.getAttribute('style'), backdrop: backdrop };
      best.style.cssText += ';position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;margin:0!important;transform:none!important;object-fit:contain!important;background:#000!important;z-index:2147483647!important';
      window.addEventListener('keydown', theaterKey, true);
    });

    // --- The language the page says it's in (the translation chip) ---
    if (window.top === window) {
      var tellLanguage = function () {
        var meta = document.querySelector('meta[http-equiv="content-language" i]');
        var lang = (document.documentElement.getAttribute('lang') || (meta && meta.getAttribute('content')) || '').trim();
        if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) BRIDGE.send('page-lang', { lang: lang });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tellLanguage);
      else tellLanguage();
    }

    // --- What the page says, for finding it in History by its words ---
    // (Settings -> History -> "Remember what pages say"; bridge.rs keeps it
    // only for a web page in a tab that isn't private.)
    if (window.top === window) {
      var tellText = function () {
        BRIDGE.request('site-tweaks').then(function (t) {
          if (!t || !t.remember_text || !document.body) return;
          var text = (document.body.innerText || '').slice(0, 60000);
          if (text.trim()) BRIDGE.send('page-text', { text: text });
        }, function () {});
      };
      var afterLoad = function () { later(tellText, 1500); };
      if (document.readyState === 'complete') afterLoad();
      else window.addEventListener('load', afterLoad, { once: true });
    }

    // --- Addresses and cards (forms.rs) ---
    // A field that wants an address or a card: Kessel shows what you've
    // saved under it, in its own list -- this page never sees that list.
    // What you pick comes back as "form-fill" and goes into the form. A
    // form sent with an address or a card in it is offered to keep.
    if (window.top === window) {
      var setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      var FORM_RULES = [
        ['cc-number', ['cc-number'], /card.?num|cc.?num|cardnumber|kartennummer|kártyaszám/i],
        ['cc-name', ['cc-name'], /name.?on.?card|card.?holder|cc.?name|karteninhaber/i],
        ['cc-exp', ['cc-exp'], /expir|exp.?date|valid.?thru|^mm.?\/?.?yy/i],
        ['cc-month', ['cc-exp-month'], /exp.?month|cc.?month|ccmonth/i],
        ['cc-year', ['cc-exp-year'], /exp.?year|cc.?year|ccyear/i],
        ['cc-csc', ['cc-csc'], /cvc|cvv|csc|security.?code/i],
        ['given', ['given-name'], /first.?name|given.?name|^fname$|vorname|keresztn/i],
        ['family', ['family-name'], /last.?name|surname|family.?name|^lname$|nachname|vezetékn/i],
        ['name', ['name'], /^(full.?name|name|your.?name|teljes.?név)$/i],
        ['email', ['email'], /e.?mail/i],
        ['tel', ['tel', 'tel-national'], /phone|mobile|telephone|^tel$/i],
        ['org', ['organization'], /company|organi[sz]ation/i],
        ['street2', ['address-line2'], /address.?2|line.?2|apartment|suite/i],
        ['street', ['street-address', 'address-line1'], /street|address|^addr|line.?1|utca/i],
        ['city', ['address-level2'], /^city|town|locality|település|város/i],
        ['region', ['address-level1'], /^state|province|region|county|megye/i],
        ['postal', ['postal-code'], /zip|postal|post.?code|postcode|irányítószám|irsz/i],
        ['country', ['country', 'country-name'], /country|ország/i],
      ];
      var formKind = function (el) {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return '';
        var type = (el.type || '').toLowerCase();
        if (/^(password|hidden|checkbox|radio|submit|button|file|image|reset|search|range|color|date)$/.test(type)) return '';
        var ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/).pop();
        var i;
        if (ac && ac !== 'on' && ac !== 'off') {
          for (i = 0; i < FORM_RULES.length; i++) if (FORM_RULES[i][1].indexOf(ac) >= 0) return FORM_RULES[i][0];
        }
        if (type === 'email') return 'email';
        if (type === 'tel') return 'tel';
        var label = el.labels && el.labels[0] ? el.labels[0].textContent : '';
        var pieces = [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), label].map(function (p) { return (p || '').trim(); }).filter(Boolean);
        for (i = 0; i < FORM_RULES.length; i++) {
          for (var j = 0; j < pieces.length; j++) if (FORM_RULES[i][2].test(pieces[j])) return FORM_RULES[i][0];
        }
        return '';
      };
      var groupOf = function (k) { return k.indexOf('cc-') === 0 ? 'card' : 'address'; };
      var formField = null, formOpen = false;
      var closeList = function () {
        if (formOpen) BRIDGE.send('form-blur', {});
        formOpen = false;
      };
      document.addEventListener('focusin', function (e) {
        var el = e.target, k = formKind(el);
        if (!k || k === 'cc-csc' || el.value) return closeList();
        formField = el;
        var r = el.getBoundingClientRect();
        formOpen = true;
        BRIDGE.send('form-focus', { kind: groupOf(k), rect: [r.left, r.top, r.width, r.height], dpr: window.devicePixelRatio || 1 });
      }, true);
      document.addEventListener('focusout', function (e) { if (e.target === formField) closeList(); }, true);
      document.addEventListener('input', function (e) { if (e.target === formField) closeList(); }, true);
      document.addEventListener('keydown', function (e) {
        if (!formOpen || e.target !== formField) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') e.preventDefault();
        else if (e.key !== 'Escape') return;
        BRIDGE.send('form-key', { key: e.key });
        if (e.key === 'Escape') formOpen = false;
      }, true);

      var two = function (n) { return (n < 10 ? '0' : '') + n; };
      var valueFor = function (k, d, f) {
        var parts = (d.name || '').trim().split(/\s+/);
        var year = String(d.exp_year || '');
        switch (k) {
          case 'name': case 'cc-name': return d.name;
          case 'given': return parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
          case 'family': return parts.length > 1 ? parts[parts.length - 1] : '';
          case 'email': return d.email;
          case 'tel': return d.phone;
          case 'org': return d.organization;
          case 'street': return d.street;
          case 'city': return d.city;
          case 'region': return d.region;
          case 'postal': return d.postal_code;
          case 'country': return d.country;
          case 'cc-number': return d.number;
          case 'cc-exp': return two(d.exp_month) + '/' + (/yyyy/i.test(f.placeholder || '') || f.maxLength === 7 ? year : year.slice(2));
          case 'cc-month': return two(d.exp_month);
          case 'cc-year': return f.maxLength === 2 ? year.slice(2) : year;
        }
        return '';
      };
      var setField = function (f, v) {
        if (f.tagName === 'SELECT') {
          var want = String(v).toLowerCase(), num = parseInt(v, 10), found = -1;
          for (var i = 0; i < f.options.length && found < 0; i++) {
            var o = f.options[i];
            if (o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want || (!isNaN(num) && parseInt(o.value, 10) === num) || (!isNaN(num) && String(num).length === 4 && o.value === String(num).slice(2))) found = i;
          }
          if (found < 0) return;
          f.selectedIndex = found;
        } else {
          setInput.call(f, v);
        }
        f.dispatchEvent(new Event('input', { bubbles: true }));
        f.dispatchEvent(new Event('change', { bubbles: true }));
      };
      BRIDGE.on('form-fill', function (m) {
        formOpen = false;
        if (!formField || !m.data) return;
        var fields = (formField.form || document).querySelectorAll('input, select');
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i], k = formKind(f);
          if (!k || k === 'cc-csc' || groupOf(k) !== m.kind || f.disabled || f.readOnly) continue;
          var v = valueFor(k, m.data, f);
          if (v) setField(f, v);
        }
      });

      // Sent: what it had in it, to offer keeping (never from a private tab:
      // Kessel decides).
      document.addEventListener('submit', function (e) {
        var form = e.target;
        if (!(form instanceof HTMLFormElement)) return;
        var address = {}, card = {}, given = '', family = '', street2 = '';
        var fields = form.querySelectorAll('input, select');
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i], k = formKind(f);
          var v = f.tagName === 'SELECT' ? (f.selectedIndex >= 0 ? (k === 'country' ? f.options[f.selectedIndex].text : f.value) : '') : f.value;
          v = (v || '').trim();
          if (!k || !v) continue;
          switch (k) {
            case 'name': address.name = v; break;
            case 'given': given = v; break;
            case 'family': family = v; break;
            case 'email': address.email = v; break;
            case 'tel': address.phone = v; break;
            case 'org': address.organization = v; break;
            case 'street': address.street = v; break;
            case 'street2': street2 = v; break;
            case 'city': address.city = v; break;
            case 'region': address.region = v; break;
            case 'postal': address.postal_code = v; break;
            case 'country': address.country = v; break;
            case 'cc-number': card.number = v; break;
            case 'cc-name': card.name = v; break;
            case 'cc-exp': var m = /^(\d{1,2})\s*\/\s*(\d{2,4})$/.exec(v); if (m) { card.exp_month = m[1]; card.exp_year = m[2]; } break;
            case 'cc-month': card.exp_month = v; break;
            case 'cc-year': card.exp_year = v; break;
          }
        }
        if (!address.name && (given || family)) address.name = (given + ' ' + family).trim();
        if (street2 && address.street) address.street += ', ' + street2;
        if (card.number || Object.keys(address).length) BRIDGE.send('form-sent', { address: address, card: card });
      }, true);
    }

    // --- The site's own search engine (OpenSearch), offered in Settings ---
    function findSearch() {
      var link = document.querySelector('link[rel="search"][type="application/opensearchdescription+xml"][href]');
      if (!link || !/^https:/.test(location.protocol)) return;
      var href;
      try {
        href = new URL(link.getAttribute('href'), location.href);
      } catch (e) {
        return;
      }
      if (href.origin !== location.origin) return;
      fetch(href.href, { credentials: 'omit' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (xml) {
        if (!xml || xml.length > 100000) return;
        var doc = new DOMParser().parseFromString(xml, 'application/xml');
        var urls = doc.getElementsByTagName('Url');
        var template = '';
        for (var i = 0; i < urls.length; i++) {
          var type = urls[i].getAttribute('type') || '';
          var method = (urls[i].getAttribute('method') || 'get').toLowerCase();
          if (type === 'text/html' && method === 'get') template = urls[i].getAttribute('template') || '';
        }
        var nameEl = doc.getElementsByTagName('ShortName')[0];
        var name = nameEl ? nameEl.textContent.trim() : location.hostname;
        if (!template || template.indexOf('{searchTerms}') < 0) return;
        // Other {parameters} have no value here: optional ones go.
        template = template.replace('{searchTerms}', '%s').replace(/[?&][^=&]+=\{[^}]*\?\}/g, '').replace(/\{[^}]*\}/g, '');
        BRIDGE.send('opensearch', { name: name, url: new URL(template, location.href).href.replace(/%25s/g, '%s') });
      }).catch(function () {});
    }
    if (window.top === window) {
      if (document.readyState === 'complete') later(findSearch, 1500);
      else window.addEventListener('load', function () { later(findSearch, 1500); });
    }

    // --- Highlights and notes: kept by their words, found again on load ---
    // (A note stays out of the page's markup -- the site's scripts can read
    // that -- and only shows in the popup you open.)
    var HL_COLORS = { yellow: '#ffe066', green: '#b5eaa6', blue: '#a9d1ff', pink: '#ffc2dc', orange: '#ffcf8f' };
    var highlights = [];
    var hlStyle = null;
    function hlColor(name) { return HL_COLORS[name] || HL_COLORS.yellow; }

    // Every text node of the page in order, and where each starts in the
    // page's text as one string.
    function textIndex() {
      var nodes = [], text = '';
      if (!document.body) return { nodes: nodes, text: text };
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentNode && n.parentNode.nodeName;
          return p === 'SCRIPT' || p === 'STYLE' || p === 'NOSCRIPT' || p === 'TEXTAREA' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
      });
      var n;
      while ((n = walker.nextNode())) {
        nodes.push({ node: n, start: text.length });
        text += n.nodeValue;
      }
      return { nodes: nodes, text: text };
    }

    function offsetOf(index, node, offset) {
      for (var i = 0; i < index.nodes.length; i++) {
        if (index.nodes[i].node === node) return index.nodes[i].start + offset;
      }
      return -1;
    }

    // Wraps the page's text from `start` to `end` in marks for highlight h.
    function wrap(index, start, end, h) {
      var marks = [];
      for (var i = 0; i < index.nodes.length; i++) {
        var item = index.nodes[i];
        var len = item.node.nodeValue.length;
        var a = Math.max(start, item.start), b = Math.min(end, item.start + len);
        if (a >= b) continue;
        var node = item.node;
        if (b - item.start < len) node.splitText(b - item.start);
        if (a > item.start) node = node.splitText(a - item.start);
        if (!node.nodeValue.trim()) continue;
        var mark = document.createElement('mark');
        mark.className = 'kessel-hl';
        mark.setAttribute('data-hl', h.id);
        mark.style.background = hlColor(h.color);
        node.parentNode.insertBefore(mark, node);
        mark.appendChild(node);
        marks.push(mark);
      }
      if (marks.length && h.note) marks[marks.length - 1].classList.add('kessel-hl-note');
      return marks.length > 0;
    }

    // Where highlight h is on the page now: the copy of its words with the
    // same text around it, else the first copy.
    function anchor(h) {
      var index = textIndex();
      var at = -1, best = -1, from = 0;
      while ((at = index.text.indexOf(h.exact, from)) >= 0) {
        var before = index.text.slice(Math.max(0, at - h.prefix.length), at);
        var after = index.text.slice(at + h.exact.length, at + h.exact.length + h.suffix.length);
        if (before === h.prefix && after === h.suffix) { best = at; break; }
        if (best < 0) best = at;
        from = at + 1;
      }
      return best >= 0 && wrap(index, best, best + h.exact.length, h);
    }

    function ensureHlStyle() {
      if (hlStyle) return;
      hlStyle = document.createElement('style');
      hlStyle.textContent = 'mark.kessel-hl{color:inherit;border-radius:2px;padding:0;cursor:pointer;box-decoration-break:clone}' +
        'mark.kessel-hl-note::after{content:"✎";font-size:.7em;vertical-align:super;margin-left:1px;opacity:.7}';
      mount(hlStyle);
    }

    function placeAll(list) {
      ensureHlStyle();
      var missing = [];
      for (var i = 0; i < list.length; i++) {
        if (document.querySelector('mark[data-hl="' + list[i].id + '"]')) continue;
        if (!anchor(list[i])) missing.push(list[i]);
      }
      return missing;
    }

    if (window.top === window) {
      BRIDGE.request('highlights').then(function (list) {
        highlights = Array.isArray(list) ? list : [];
        if (!highlights.length) return;
        var go = function () {
          var missing = placeAll(highlights);
          // Pages that build their text late: once more after a while.
          if (missing.length) later(function () { placeAll(missing); }, 2500);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
        else go();
      });
    }

    BRIDGE.on('highlight', function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      var range = sel.getRangeAt(0);
      var exact = range.toString();
      if (!exact.trim()) return;
      var index = textIndex();
      var start = offsetOf(index, range.startContainer, range.startOffset);
      var end = offsetOf(index, range.endContainer, range.endOffset);
      if (start < 0 || end <= start) {
        // The selection starts or ends on an element, not in text: by its words.
        start = index.text.indexOf(exact);
        end = start + exact.length;
        if (start < 0) return;
      }
      exact = index.text.slice(start, end);
      var h = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        exact: exact,
        prefix: index.text.slice(Math.max(0, start - 32), start),
        suffix: index.text.slice(end, end + 32),
        color: HL_COLORS[tweaks.highlight_color] ? tweaks.highlight_color : 'yellow',
        note: '',
        title: document.title
      };
      ensureHlStyle();
      if (!wrap(index, start, end, h)) return;
      sel.removeAllRanges();
      highlights.push(h);
      BRIDGE.send('highlight-add', h);
    });

    // Click a highlight: its colour, a note, or remove it.
    var hlMenu = null;
    function closeHlMenu() {
      if (hlMenu) hlMenu.remove();
      hlMenu = null;
    }
    function marksOf(id) { return document.querySelectorAll('mark[data-hl="' + id + '"]'); }
    document.addEventListener('click', function (e) {
      if (hlMenu && hlMenu.contains(e.target)) return;
      var mark = e.target.closest && e.target.closest('mark.kessel-hl');
      closeHlMenu();
      if (!mark || (window.getSelection() && !window.getSelection().isCollapsed)) return;
      e.preventDefault();
      var id = mark.getAttribute('data-hl');
      var h = null;
      for (var i = 0; i < highlights.length; i++) if (highlights[i].id === id) h = highlights[i];
      if (!h) return;
      var r = mark.getBoundingClientRect();
      hlMenu = document.createElement('div');
      hlMenu.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.min(r.left, innerWidth - 270) + 'px;top:' + (r.bottom + 6 > innerHeight - 170 ? Math.max(8, r.top - 170) : r.bottom + 6) + 'px;width:260px;background:#16171d;color:#eee;font:12.5px system-ui,sans-serif;padding:10px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)';
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;align-items:center';
      Object.keys(HL_COLORS).forEach(function (c) {
        var b = document.createElement('button');
        b.title = c;
        b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid ' + (c === h.color ? '#fff' : 'transparent') + ';background:' + HL_COLORS[c] + ';cursor:pointer;padding:0';
        b.addEventListener('click', function () {
          h.color = c;
          var ms = marksOf(id);
          for (var k = 0; k < ms.length; k++) ms[k].style.background = HL_COLORS[c];
          BRIDGE.send('highlight-update', { id: id, color: c });
          closeHlMenu();
        });
        row.appendChild(b);
      });
      var del = document.createElement('button');
      del.textContent = 'Remove';
      del.style.cssText = 'margin-left:auto;background:none;border:1px solid #555;color:#eee;border-radius:7px;padding:3px 8px;cursor:pointer;font:12px system-ui';
      del.addEventListener('click', function () {
        var ms = marksOf(id);
        for (var k = 0; k < ms.length; k++) {
          var m = ms[k], parent = m.parentNode;
          while (m.firstChild) parent.insertBefore(m.firstChild, m);
          parent.removeChild(m);
          parent.normalize();
        }
        highlights = highlights.filter(function (x) { return x.id !== id; });
        BRIDGE.send('highlight-remove', { id: id });
        closeHlMenu();
      });
      row.appendChild(del);
      var note = document.createElement('textarea');
      note.placeholder = 'Add a note…';
      note.value = h.note || '';
      note.rows = 3;
      note.style.cssText = 'width:100%;box-sizing:border-box;background:#0e0f13;color:#eee;border:1px solid #333;border-radius:8px;padding:6px;font:12.5px system-ui;resize:vertical';
      note.addEventListener('change', function () {
        h.note = note.value.slice(0, 5000);
        var ms = marksOf(id);
        for (var k = 0; k < ms.length; k++) {
          ms[k].classList.toggle('kessel-hl-note', !!h.note && k === ms.length - 1);
        }
        BRIDGE.send('highlight-update', { id: id, note: h.note });
      });
      hlMenu.appendChild(row);
      hlMenu.appendChild(note);
      document.documentElement.appendChild(hlMenu);
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeHlMenu(); }, true);

    // --- Logins: what you typed, as you sign in (passwords.rs asks whether
    // to save it). Never sent anywhere else; nothing here when the page
    // has no password field. ---
    if (window.top === window) (function () {
      var lastSent = '';
      function visible(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
      // The password that counts: with two or more (sign up, change
      // password), the last one -- the new one.
      function passwordIn(scope) {
        var all = scope.querySelectorAll('input[type="password"]');
        var pick = null;
        for (var i = 0; i < all.length; i++) if (all[i].value && visible(all[i])) pick = all[i];
        return pick;
      }
      function userFieldFor(pw) {
        var scope = pw.closest('form') || document;
        var named = scope.querySelector('input[autocomplete="username"], input[autocomplete="email"]');
        if (named && named.value) return named;
        var fields = scope.querySelectorAll('input[type="email"], input[type="text"], input[type="tel"], input:not([type])');
        var best = null;
        // The last text field before the password.
        for (var i = 0; i < fields.length; i++) {
          var f = fields[i];
          if (!f.value || !visible(f)) continue;
          if (f.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = f;
        }
        return best;
      }
      function capture(pw) {
        if (!pw || !pw.value) return;
        var user = userFieldFor(pw);
        var username = user ? String(user.value).trim() : '';
        var key = username + '\n' + pw.value;
        if (key === lastSent) return;
        lastSent = key;
        BRIDGE.send('login', { username: username.slice(0, 500), password: String(pw.value).slice(0, 500) });
      }
      document.addEventListener('submit', function (e) {
        var pw = e.target && e.target.querySelectorAll ? passwordIn(e.target) : null;
        if (pw) capture(pw);
      }, true);
      // Sign-ins that never send a form (most new sites): Enter in the
      // password field, or a click on a button next to it.
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target && e.target.type === 'password') capture(e.target);
      }, true);
      document.addEventListener('click', function (e) {
        var button = e.target && e.target.closest && e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
        if (!button) return;
        var scope = button.closest('form') || button.parentElement && button.parentElement.closest('div, section, main') || document;
        var pw = passwordIn(scope) || passwordIn(document);
        if (pw) capture(pw);
      }, true);
    })();
  })();
