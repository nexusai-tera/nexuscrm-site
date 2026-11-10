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

// Google Analytics: runs only for visitors who choose Allow, and stays off until GA_ID is set.
(function () {
  var GA_ID = 'G-6RR6NN5FDP';
  var CHOICE_KEY = 'nexuscrm-analytics';
  var active = false;

  // records an event when analytics is on; `then` always runs, within 600ms at most
  window.nexusTrack = function (name, params, then) {
    if (!active) { if (then) then(); return; }
    var details = params || {};
    if (then) {
      var finished = false;
      var finish = function () { if (!finished) { finished = true; then(); } };
      details.event_callback = finish;
      setTimeout(finish, 600);
    }
    window.gtag('event', name, details);
  };

  if (!GA_ID) return;

  function savedChoice() {
    try { return localStorage.getItem(CHOICE_KEY); } catch (err) { return null; }
  }

  function start() {
    active = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, {
      cookie_domain: location.hostname,
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(script);
  }

  function clearAnalyticsCookies() {
    document.cookie.split(';').forEach(function (cookie) {
      var name = cookie.split('=')[0].trim();
      if (name.indexOf('_ga') === 0) {
        document.cookie = name + '=; Max-Age=0; path=/; domain=' + location.hostname;
        document.cookie = name + '=; Max-Age=0; path=/';
      }
    });
  }

  function choose(choice) {
    try { localStorage.setItem(CHOICE_KEY, choice); } catch (err) {}
    var bar = document.getElementById('consent');
    if (bar) bar.remove();
    if (choice === 'granted' && !active) start();
    if (choice === 'denied' && active) {
      clearAnalyticsCookies();
      location.reload();
    }
  }

  function showConsent() {
    if (document.getElementById('consent')) return;
    var bar = document.createElement('div');
    bar.id = 'consent';
    bar.className = 'consent';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Analytics choice');
    bar.innerHTML = '<p>May we use Google Analytics cookies to see how this site gets used? '
      + 'The site works the same either way. <a href="https://nexusaigta.ca/privacy">Privacy Policy</a></p>'
      + '<div class="consent-actions">'
      + '<button class="btn" type="button" data-choice="denied">No thanks</button>'
      + '<button class="btn" type="button" data-choice="granted">Allow</button>'
      + '</div>';
    bar.addEventListener('click', function (e) {
      var choice = e.target.getAttribute('data-choice');
      if (choice) choose(choice);
    });
    document.body.appendChild(bar);
  }

  var choice = savedChoice();
  if (choice === 'granted') start();
  if (!choice) showConsent();

  // lets a visitor change their answer later
  var legal = document.querySelector('.foot-bottom span');
  if (legal) {
    var change = document.createElement('a');
    change.href = '#';
    change.textContent = 'Cookie choices';
    change.addEventListener('click', function (e) { e.preventDefault(); showConsent(); });
    legal.appendChild(document.createTextNode(' · '));
    legal.appendChild(change);
  }

  // the clicks that signal buying intent
  document.addEventListener('click', function (e) {
    var link = e.target.closest ? e.target.closest('a') : null;
    if (!link) return;
    var href = link.getAttribute('href') || '';
    var where = link.closest('.nav') ? 'nav' : link.closest('footer') ? 'footer' : 'page';
    if (href.indexOf('tel:') === 0) window.nexusTrack('phone_click', { link_location: where });
    else if (href.indexOf('mailto:') === 0) window.nexusTrack('email_click', { link_location: where });
    else if (link.classList.contains('btn')) window.nexusTrack('cta_click', { cta_text: link.textContent.trim(), link_location: where, link_url: href });
  });
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

  form.addEventListener('input', function () { window.nexusTrack('demo_form_start'); }, { once: true });

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
      window.nexusTrack('generate_lead', { form_name: 'demo-request' }, function () {
        window.location.href = 'thanks.html';
      });
    }).catch(function () {
      clearTimeout(timeout);
      setSending(false);
      document.getElementById('form-email-fallback').href = emailFallback();
      error.hidden = false;
      window.nexusTrack('demo_form_error');
    });
  });
})();
