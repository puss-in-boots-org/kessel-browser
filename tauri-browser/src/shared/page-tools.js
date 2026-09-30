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
      if (tweaks.css) css += tweaks.css + '\n';
      style.textContent = css;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = null;
      var every = +tweaks.reload || 0;
      if (every >= 5) reloadTimer = later(function () { location.reload(); }, every * 1000);
      if (tweaks.deamp) deAmp();
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

    BRIDGE.request('site-tweaks').then(apply);
    BRIDGE.on('tweaks-changed', function () { BRIDGE.request('site-tweaks').then(apply); });

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
  })();
