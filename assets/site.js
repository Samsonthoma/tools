/* Shared navigation bar, footer and (on the home page) the tools grid.
   Include in every page's <head>:  <script src="assets/site.js" defer></script> */
(function () {
  var script = document.currentScript;
  var base = script.src.replace(/assets\/site\.js.*$/, '');
  function load(src, cb) { var s = document.createElement('script'); s.src = src; s.onload = cb; document.head.appendChild(s); }
  var css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'assets/site.css'; document.head.appendChild(css);

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
    nav.innerHTML = '<div class="sis-nav-inner"><a class="sis-brand" href="' + base + '">🧰 ' + esc(S.name) + '</a>' +
      '<button class="sis-toggle" type="button" aria-label="Toggle menu" aria-expanded="false">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>' +
      '<ul class="sis-menu">' + links + '</ul></div>';
    document.body.insertBefore(nav, document.body.firstChild);
    var btn = nav.querySelector('.sis-toggle'), menu = nav.querySelector('.sis-menu');
    btn.addEventListener('click', function () { btn.setAttribute('aria-expanded', menu.classList.toggle('open')); });
    menu.addEventListener('click', function (e) { if (e.target.tagName === 'A') { menu.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });

    var f = document.createElement('footer');
    f.className = 'sis-footer';
    f.innerHTML = '&copy; <a href="' + S.school.url + '" target="_blank" rel="noopener">' + esc(S.school.name) + '</a> &middot; Developed by <a href="' + S.developer.url + '" target="_blank" rel="noopener author">' + esc(S.developer.name) + '</a>';
    document.body.appendChild(f);

    var grid = document.getElementById('tools-grid');
    if (grid) {
      grid.innerHTML = S.tools.map(function (t) {
        return '<a class="sis-card" style="--c:' + t.color + '" href="' + t.href + '"><div class="ic">' + t.icon + '</div><h2>' + esc(t.title) + '</h2><p>' + esc(t.desc) + '</p></a>';
      }).join('');
    }
  }

  function init() { window.SITE ? build() : load(base + 'assets/tools.js', build); }
  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
