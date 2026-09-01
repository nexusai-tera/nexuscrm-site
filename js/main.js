// NexusCRM marketing site — shared behavior
(function () {
  // mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  // mark current page in nav
  var here = location.pathname.replace(/\/index\.html$/, '/');
  document.querySelectorAll('.nav-links a').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('http')) return;
    var resolved = new URL(href, location.href).pathname.replace(/\/index\.html$/, '/');
    if (resolved === here || resolved === location.pathname) {
      a.setAttribute('aria-current', 'page');
    }
  });

  // reveal-on-scroll (subtle)
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.style.opacity = 1; en.target.style.transform = 'none'; io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.card, .tier, .step, .quote').forEach(function (el) {
      el.style.opacity = 0;
      el.style.transform = 'translateY(14px)';
      el.style.transition = 'opacity .5s ease, transform .5s ease';
      io.observe(el);
    });
  }
})();

// demo form → composes a pre-filled email (static hosting has no form backend)
(function () {
  var form = document.getElementById('demo-form');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = function (n) { var el = form.elements[n]; return el && el.value ? el.value : '—'; };
    var body = [
      'Demo request from crm.nexusaigta.ca', '',
      'Name: ' + v('name'),
      'Company: ' + v('company'),
      'Email: ' + v('email'),
      'Phone: ' + v('phone'),
      'Industry: ' + v('industry'),
      'Team size: ' + v('team_size'),
      'Heard about us: ' + v('source'), '',
      'Biggest operations headache:',
      v('message')
    ].join('\n');
    window.location.href = 'mailto:hello@nexusaigta.ca'
      + '?subject=' + encodeURIComponent('NexusCRM Demo Request — ' + v('company'))
      + '&body=' + encodeURIComponent(body);
    setTimeout(function () { window.location.href = 'thanks.html'; }, 1200);
  });
})();
