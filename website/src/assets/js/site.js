/* RedClinic marketing site script. No dependencies, no third-party calls. */
(function () {
  'use strict';
  var doc = document.documentElement;
  doc.classList.add('js');
  var isPreview = doc.getAttribute('data-preview') === 'true';

  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  var session = store('sessionStorage');

  /* ---------- Analytics: first-party event layer ----------
     Events go to window.dataLayer, so a tag manager can pick them up once one is approved.
     Nothing personal is ever included, and nothing leaves the browser unless an endpoint is
     configured (data-analytics-endpoint on <html>) and the visitor has agreed. */
  window.dataLayer = window.dataLayer || [];
  var endpoint = doc.getAttribute('data-analytics-endpoint') || '';
  function device() { var w = window.innerWidth; return w < 761 ? 'mobile' : w < 1025 ? 'tablet' : 'desktop'; }
  function consented() { var ls = store('localStorage'); try { return ls && ls.getItem('rc-consent') === 'granted'; } catch (e) { return false; } }

  function attribution() {
    var saved = null;
    try { saved = session && JSON.parse(session.getItem('rc-attr') || 'null'); } catch (e) {}
    if (saved) return saved;
    var q = new URLSearchParams(location.search);
    var a = {
      landing_page: location.pathname,
      referrer: document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer.slice(0, 300) : '',
      utm_source: q.get('utm_source') || '', utm_medium: q.get('utm_medium') || '', utm_campaign: q.get('utm_campaign') || '',
      utm_term: q.get('utm_term') || '', utm_content: q.get('utm_content') || '',
      click_id: q.get('gclid') ? 'gclid' : q.get('fbclid') ? 'fbclid' : ''
    };
    try { session && session.setItem('rc-attr', JSON.stringify(a)); } catch (e) {}
    return a;
  }
  var attr = attribution();

  function track(name, props) {
    var e = Object.assign({ event: name, page: location.pathname, device: device(), source: attr.utm_source || (attr.referrer ? 'referral' : 'direct'), landing_page: attr.landing_page }, props || {});
    window.dataLayer.push(e);
    if (endpoint && consented() && navigator.sendBeacon) {
      try { navigator.sendBeacon(endpoint, JSON.stringify(e)); } catch (err) {}
    }
  }
  window.rcTrack = track;
  track('page_view');

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-track]');
    if (el) track(el.getAttribute('data-track'), { location: el.getAttribute('data-loc') || '', label: (el.textContent || '').trim().slice(0, 40) });
  });

  /* ---------- Header ---------- */
  var header = document.querySelector('.site-header');
  var nav = document.getElementById('site-nav');
  var toggle = document.querySelector('.menu-toggle');
  function onScroll() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  if (toggle && nav) {
    toggle.addEventListener('click', function (ev) {
      ev.preventDefault();
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && nav.classList.contains('is-open')) { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
    nav.addEventListener('click', function (ev) { if (ev.target.closest('a')) { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); } });
  }

  /* ---------- Hero: play the call once when it's on screen ---------- */
  var stage = document.querySelector('[data-play]');
  if (stage) {
    if ('IntersectionObserver' in window) {
      var playObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) { stage.classList.add('play'); playObs.disconnect(); } });
      }, { threshold: 0.25 });
      playObs.observe(stage);
    }
  }

  /* ---------- Sample call tabs ---------- */
  document.querySelectorAll('[data-tabs]').forEach(function (root) {
    var list = root.querySelector('[data-tablist]');
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role=tab]'));
    if (!list || !tabs.length) return;
    list.hidden = false;
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); track('sample_call_view', { call: t.id.replace('tab-', '') }); });
      t.addEventListener('keydown', function (ev) {
        var n = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
        if (n) { ev.preventDefault(); select(tabs[(i + n + tabs.length) % tabs.length], true); }
      });
    });
    select(tabs[0]);
  });

  /* ---------- Pricing: billing period switch ---------- */
  document.querySelectorAll('[data-billing]').forEach(function (root) {
    var sw = root.querySelector('[data-billing-switch]');
    if (!sw) return;
    var btns = Array.prototype.slice.call(sw.querySelectorAll('[data-period]'));
    sw.hidden = false;
    function pick(btn, focus) {
      btns.forEach(function (b) { var on = b === btn; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      root.setAttribute('data-billing', btn.getAttribute('data-period'));
      if (focus) btn.focus();
    }
    btns.forEach(function (b, i) {
      b.addEventListener('click', function () { pick(b); track('billing_period', { period: b.getAttribute('data-period') }); });
      b.addEventListener('keydown', function (ev) {
        var n = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
        if (n) { ev.preventDefault(); pick(btns[(i + n + btns.length) % btns.length], true); }
      });
    });
    pick(btns[0]);
  });

  /* ---------- Sticky mobile CTA ---------- */
  var sticky = document.querySelector('[data-sticky-cta]');
  if (sticky && location.pathname.indexOf('/demo') !== 0 && !/demo\/index\.html$/.test(location.pathname)) {
    sticky.hidden = false;
    var blockers = document.querySelectorAll('[data-form-shell], .site-footer, .cta-band');
    var blocked = 0;
    function updateSticky() { sticky.classList.toggle('is-visible', window.scrollY > 560 && blocked === 0); }
    if ('IntersectionObserver' in window) {
      var seen = new Set();
      var stickyObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) seen.add(en.target); else seen.delete(en.target); });
        blocked = seen.size; updateSticky();
      });
      blockers.forEach(function (b) { stickyObs.observe(b); });
    }
    window.addEventListener('scroll', updateSticky, { passive: true });
  }

  /* ---------- Demo request form ---------- */
  var MESSAGES = {
    name: 'Enter your name.',
    phone: 'Enter a 10-digit Indian mobile number.',
    clinic: "Enter your clinic's name.",
    city: 'Enter the city your clinic is in.',
  };

  function normalisePhone(v) {
    var d = String(v || '').replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d;
  }

  function validate(data) {
    var errors = {};
    var name = data.name.trim();
    if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name)) errors.name = MESSAGES.name;
    if (!/^[6-9]\d{9}$/.test(normalisePhone(data.phone))) errors.phone = MESSAGES.phone;
    if (data.clinic.trim().length < 2) errors.clinic = MESSAGES.clinic;
    if (data.city.trim().length < 2) errors.city = MESSAGES.city;
    return errors;
  }

  document.querySelectorAll('[data-demo-form]').forEach(function (form) {
    var shell = form.closest('[data-form-shell]');
    var done = shell.querySelector('[data-form-done]');
    var status = form.querySelector('[data-form-status]');
    var button = form.querySelector('[data-submit]');
    var openedAt = Date.now();
    var started = false, submitted = false, lastField = '';


    function fieldBox(name) {
      var input = form.elements[name];
      var el = input && (input.length ? input[0] : input);
      return el ? el.closest('.field') : null;
    }
    function showError(name, msg) {
      var box = fieldBox(name);
      var err = document.getElementById('f-' + name + '-err');
      if (!box || !err) return;
      box.classList.toggle('has-error', !!msg);
      err.textContent = msg || '';
      err.hidden = !msg;
      var input = form.elements[name];
      var targets = input.length ? Array.prototype.slice.call(input) : [input];
      targets.forEach(function (t) {
        if (msg) { t.setAttribute('aria-invalid', 'true'); t.setAttribute('aria-describedby', 'f-' + name + '-err'); }
        else { t.removeAttribute('aria-invalid'); if (name !== 'phone') t.removeAttribute('aria-describedby'); else t.setAttribute('aria-describedby', 'f-phone-hint'); }
      });
    }
    function setStatus(msg, info) {
      status.textContent = msg || '';
      status.hidden = !msg;
      status.classList.toggle('is-info', !!info);
    }
    function values() {
      var fd = new FormData(form);
      return {
        name: fd.get('name') || '', phone: fd.get('phone') || '', clinic: fd.get('clinic') || '', city: fd.get('city') || '',
        size: fd.get('size') || '', speciality: fd.get('speciality') || '', plan: fd.get('plan') || '', call_time: fd.get('call_time') || '', rc_hp: fd.get('rc_hp') || ''
      };
    }

    form.addEventListener('input', function (ev) {
      lastField = ev.target.name || lastField;
      if (!started) { started = true; track('form_start', { form: 'demo' }); }
      if (ev.target.closest('.field.has-error')) {
        var errs = validate(values());
        showError(ev.target.name, errs[ev.target.name]);
      }
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      setStatus('');
      var data = values();
      var errors = validate(data);
      Object.keys(MESSAGES).forEach(function (k) { showError(k, errors[k]); });
      var keys = Object.keys(errors);
      track('form_submit', { form: 'demo', valid: keys.length === 0 });
      if (keys.length) {
        track('form_error', { form: 'demo', fields: keys.join(',') });
        var first = form.elements[keys[0]];
        (first.length ? first[0] : first).focus();
        return;
      }
      if (isPreview) {
        setStatus('This is a preview. The form saves requests once the site runs on the RedClinic server, so nothing was sent.', true);
        return;
      }
      var payload = Object.assign({}, data, { phone: normalisePhone(data.phone), elapsed_ms: Date.now() - openedAt, device: device() }, attr);
      button.disabled = true;
      button.textContent = 'Sending…';
      var ctrl = 'AbortController' in window ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
      fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload), signal: ctrl ? ctrl.signal : undefined, credentials: 'same-origin'
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) { return { res: res, body: body }; });
      }).then(function (r) {
        clearTimeout(timer);
        if (r.res.status === 201 && r.body && r.body.reference) {
          submitted = true;
          track('lead_submitted', { form: 'demo' });
          var parts = data.name.trim().split(/\s+/);
          var first = /^(dr|mr|mrs|ms|prof)\.?$/i.test(parts[0]) && parts[1] ? parts[0] + ' ' + parts[1] : parts[0];
          shell.querySelector('[data-done-title]').textContent = 'Thank you, ' + first + '.';
          shell.querySelector('[data-done-ref]').textContent = r.body.reference;
          shell.querySelector('[data-done-phone]').textContent = '+91 ' + payload.phone.slice(0, 5) + ' ' + payload.phone.slice(5);
          form.hidden = true;
          done.hidden = false;
          done.focus({ preventScroll: true });
          shell.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        if (r.res.status === 400 && r.body && r.body.errors) {
          var known = Object.keys(r.body.errors).filter(function (k) { return k in MESSAGES; });
          known.forEach(function (k) { showError(k, MESSAGES[k]); });
          if (!known.length) setStatus("We couldn't accept this request. Please try again, or call us on " + phoneText() + '.');
          track('form_error', { form: 'demo', fields: Object.keys(r.body.errors).join(','), server: true });
          throw { handled: true };
        }
        if (r.res.status === 429) {
          setStatus('Too many attempts from this connection. Wait a few minutes and try again, or call us on ' + phoneText() + '.');
          throw { handled: true };
        }
        throw new Error('status ' + r.res.status);
      }).catch(function (err) {
        clearTimeout(timer);
        if (!(err && err.handled)) {
          setStatus("Your request didn't go through, so nothing was saved. Check your connection and try again, or call us on " + phoneText() + '.');
          track('form_error', { form: 'demo', fields: 'network' });
        }
      }).then(function () {
        if (!submitted) { button.disabled = false; button.textContent = 'Book my free demo'; }
      });
    });

    function phoneText() { var a = document.querySelector('a[href^="tel:"]'); return a ? a.textContent.trim() : 'our clinic support line'; }

    window.addEventListener('pagehide', function () {
      if (started && !submitted) track('form_abandon', { form: 'demo', last_field: lastField });
    });
  });
})();
