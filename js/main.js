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

// demo form → posts to Formspree, which emails info@nexusaigta.ca.
// The thank-you page only appears once Formspree has accepted the request.
(function () {
  // remember where this visit started, so the request can report it from any page
  var TOUCH_KEY = 'nexuscrm-first-touch';
  var touch;
  try { touch = JSON.parse(sessionStorage.getItem(TOUCH_KEY)); } catch (err) {}
  if (!touch) {
    var params = new URLSearchParams(location.search);
    touch = { landing_page: location.pathname, referrer: document.referrer };
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach(function (k) {
      if (params.get(k)) touch[k] = params.get(k);
    });
    try { sessionStorage.setItem(TOUCH_KEY, JSON.stringify(touch)); } catch (err) {}
  }

  var form = document.getElementById('demo-form');
  if (!form) return;
  var button = form.querySelector('button[type="submit"]');
  var error = document.getElementById('form-error');
  var idleLabel = button.textContent;
  var sending = false;

  function setSending(on) {
    sending = on;
    button.disabled = on;
    button.textContent = on ? 'Sending…' : idleLabel;
  }

  // if the send fails, the visitor can still reach us with what they typed
  function emailFallback() {
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
    return 'mailto:info@nexusaigta.ca'
      + '?subject=' + encodeURIComponent('NexusCRM Demo Request — ' + v('company'))
      + '&body=' + encodeURIComponent(body);
  }

  // the button stays in "Sending…" after success, so reset it on a back-button return
  window.addEventListener('pageshow', function (e) { if (e.persisted) setSending(false); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    setSending(true);
    error.hidden = true;

    var data = new FormData(form);
    data.append('_subject', 'NexusCRM Demo Request — ' + form.elements.company.value);
    Object.keys(touch).forEach(function (k) { if (touch[k]) data.append(k, touch[k]); });

    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 15000);
    fetch(form.action, {
      method: 'POST',
      body: data,
      headers: { Accept: 'application/json' },
      signal: controller.signal
    }).then(function (res) {
      clearTimeout(timeout);
      if (!res.ok) throw new Error('Form rejected: ' + res.status);
      window.location.href = 'thanks.html';
    }).catch(function () {
      clearTimeout(timeout);
      setSending(false);
      document.getElementById('form-email-fallback').href = emailFallback();
      error.hidden = false;
    });
  });
})();
