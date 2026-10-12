/* Shared navigation bar, footer and (on the home page) the tools grid.
   Include in every page's <head>:  <script src="assets/site.js" defer></script> */
(function () {
  var script = document.currentScript;
  var base = script.src.replace(/assets\/site\.js.*$/, '');
  function load(src, cb) { var s = document.createElement('script'); s.src = src; s.onload = cb; document.head.appendChild(s); }
  var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'assets/site.css'; document.head.appendChild(css);

  [['icon', 'favicon.ico', 'image/x-icon'], ['apple-touch-icon', 'logo.png', 'image/png']].forEach(function (i) {
    var l = document.createElement('link'); l.rel = i[0]; l.href = base + i[1]; l.type = i[2]; document.head.appendChild(l);
  });
  [['name', 'author', 'Samson Thomas'], ['property', 'og:image', base + 'logo.png'], ['name', 'twitter:image', base + 'logo.png']].forEach(function (m) {
    if (document.head.querySelector('meta[' + m[0] + '="' + m[1] + '"]')) return;
    var e = document.createElement('meta'); e.setAttribute(m[0], m[1]); e.content = m[2]; document.head.appendChild(e);
  });

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  function build() {
    var S = window.SITE, here = location.pathname.split('/').pop() || 'index.html';
    var links = '<li><a href="' + base + '"' + (here === 'index.html' ? ' class="active"' : '') + '>Home</a></li>';
    S.tools.forEach(function (t) {
      links += '<li><a href="' + base + t.href + '"' + (here === t.href ? ' class="active"' : '') + '>' + esc(t.title) + '</a></li>';
    });
    links += '<li class="sis-sep"></li>' +
      '<li><a href="' + S.school.url + '" target="_blank" rel="noopener">School</a></li>' +
      '<li><a href="' + S.developer.url + '" target="_blank" rel="noopener author">Developer</a></li>';

    var nav = document.createElement('nav');
    nav.className = 'sis-nav'; nav.setAttribute('aria-label', 'Site');
    nav.innerHTML = '<div class="sis-nav-inner"><a class="sis-brand" href="' + base + '"><img src="' + base + 'logo.png" alt="" width="28" height="28" style="vertical-align:middle;margin-right:8px;border-radius:6px">' + esc(S.name) + '</a>' +
      '<button class="sis-toggle" type="button" aria-label="Toggle menu" aria-expanded="false">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>' +
      '<ul class="sis-menu">' + links + '</ul></div>';
    document.body.insertBefore(nav, document.body.firstChild);
    setupAuth(nav.querySelector('.sis-menu'));
    var btn = nav.querySelector('.sis-toggle'), menu = nav.querySelector('.sis-menu');
    btn.addEventListener('click', function () { btn.setAttribute('aria-expanded', menu.classList.toggle('open')); });
    menu.addEventListener('click', function (e) { if (e.target.tagName === 'A') { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });

    var f = document.createElement('footer');
    f.className = 'sis-footer';
    f.innerHTML = '&copy; <a href="' + S.school.url + '" target="_blank" rel="noopener">' + esc(S.school.name) + '</a> &middot; Developed by <a href="' + S.developer.url + '" target="_blank" rel="noopener author">' + esc(S.developer.name) + '</a> &middot; <a href="' + base + 'privacy.html">Privacy Policy</a> &middot; <a href="' + base + 'terms.html">Terms of Service</a>';
    document.body.appendChild(f);

    var grid = document.getElementById('tools-grid');
    if (grid) {
      grid.innerHTML = S.tools.map(function (t) {
        return '<a class="sis-card" style="--c:' + t.color + '" href="' + t.href + '"><div class="ic">' + t.icon + '</div><h2>' + esc(t.title) + '</h2><p>' + esc(t.desc) + '</p></a>';
      }).join('');
    }
  }

  /* Shared Google sign-in. Other scripts can use window.TSISAuth.getToken()
     (a Google ID token to send as an "Authorization: Bearer" header to SITE.apiUrl)
     and listen for the "tsis-auth" event on window. */
  var KEY = 'tsis_google_id_token';
  function parseJwt(t) {
    try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return null; }
  }
  var Auth = window.TSISAuth = {
    getToken: function () {
      var t = null; try { t = sessionStorage.getItem(KEY); } catch (e) {}
      var p = t && parseJwt(t);
      if (!p || p.exp * 1000 < Date.now()) { if (t) Auth.signOut(); return null; }
      return t;
    },
    getUser: function () { var t = Auth.getToken(); return t ? parseJwt(t) : null; },
    signOut: function () {
      try { sessionStorage.removeItem(KEY); } catch (e) {}
      if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
      window.dispatchEvent(new Event('tsis-auth'));
    }
  };
  function setupAuth(menu) {
    var li = document.createElement('li'); li.className = 'sis-auth'; menu.appendChild(li);
    var clientId = null, inited = false;
    function render() {
      var u = Auth.getUser();
      li.innerHTML = '';
      if (u) {
        var span = document.createElement('span'); span.className = 'sis-user'; span.textContent = u.name || u.email;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'sis-signout'; b.textContent = 'Sign out';
        b.onclick = Auth.signOut;
        li.appendChild(span); li.appendChild(b);
      } else if (inited) {
        var d = document.createElement('div'); li.appendChild(d);
        google.accounts.id.renderButton(d, { theme: 'outline', size: 'medium', text: 'signin_with', shape: 'rectangular' });
      } else {
        li.textContent = '';
      }
    }
    function init() {
      if (inited || !clientId || !(window.google && google.accounts && google.accounts.id)) return;
      google.accounts.id.initialize({ client_id: clientId, callback: function (r) {
        try { sessionStorage.setItem(KEY, r.credential); } catch (e) {}
        window.dispatchEvent(new Event('tsis-auth'));
      } });
      inited = true; render();
    }
    window.addEventListener('tsis-auth', render);
    var g = document.createElement('script'); g.src = 'https://accounts.google.com/gsi/client'; g.async = true; g.onload = init; document.head.appendChild(g);
    fetch(window.SITE.apiUrl + '/api/config').then(function (r) { return r.json(); })
      .then(function (c) { clientId = c.googleClientId; init(); }).catch(function () {});
    render();
  }

  function init() { window.SITE ? build() : load(base + 'assets/tools.js', build); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
