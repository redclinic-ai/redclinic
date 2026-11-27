/* RedClinic pilot application. No dependencies.
   Saving: the answers go to two places at once, the /api/apply function (Netlify Blobs) and
   Netlify Forms. Success is shown only when at least one of them confirms. If both fail, the
   answers are kept on the device and sent again automatically on the next visit. */
(function () {
  'use strict';

  var SEATS = 11;
  var REDIRECT_URL = 'https://navapilot.com';
  var REDIRECT_SECONDS = 5;
  var TIMEOUT_MS = 15000;
  var DRAFT_KEY = 'rc-pilot-draft';
  var PENDING_KEY = 'rc-pilot-pending';
  var DONE_KEY = 'rc-pilot-done';
  var LABELS = {
    booking: 'Appointment booking', reminders: 'Appointment reminders', followups: 'Patient follow-ups',
    noshow: 'No-show recovery', treatment: 'Treatment follow-ups', enquiries: 'Patient enquiry handling',
    leads: 'Lead management', tasks: 'Daily task coordination', records: 'Patient record organization',
    assistant: 'AI clinic assistant'
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function storage(kind) { try { var s = window[kind]; s.setItem('_t', '1'); s.removeItem('_t'); return s; } catch (e) { return null; } }
  var local = storage('localStorage');
  var session = storage('sessionStorage');
  function read(store, key) { try { return store ? JSON.parse(store.getItem(key) || 'null') : null; } catch (e) { return null; } }
  function write(store, key, val) { try { store && (val == null ? store.removeItem(key) : store.setItem(key, JSON.stringify(val))); } catch (e) {} }

  var form = $('[data-form]');
  var top = $('[data-top]');
  var backBtn = $('[data-back]');
  var progress = $('[data-progress]');
  var count = $('[data-count]');
  var nameEl = $('#f-name');
  var phoneEl = $('#f-phone');
  var clinicEl = $('#f-clinic');
  var chips = $$('.chip input');
  var submitBtn = $('[data-submit]');
  var startedAt = Date.now();

  $$('[data-seat-count], .seats-done b').forEach(function (el) { el.textContent = SEATS; });

  /* ---------- Attribution (kept with the application) ---------- */
  var attr = read(session, 'rc-attr');
  if (!attr) {
    var q = new URLSearchParams(location.search);
    attr = {
      utm_source: q.get('utm_source') || '', utm_medium: q.get('utm_medium') || '', utm_campaign: q.get('utm_campaign') || '',
      utm_content: q.get('utm_content') || '', utm_term: q.get('utm_term') || '',
      referrer: document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer.slice(0, 300) : '',
      click_id: q.get('fbclid') ? 'fbclid' : q.get('gclid') ? 'gclid' : ''
    };
    write(session, 'rc-attr', attr);
  }

  /* ---------- State ---------- */
  var state = { role: '', name: '', phone: '', clinic: '', outcomes: [] };
  var current = null;
  var depth = 0; // history entries this page has pushed
  var ORDER = { '1': 1, '2': 2, '3': 3, none: 1, done: 4 };

  function saveDraft() { write(session, DRAFT_KEY, { s: state, step: current && current !== 'done' && current !== 'none' ? current : '1' }); }

  function digits(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2); if (d.length === 11 && d[0] === '0') d = d.slice(1); return d; }
  function fmtPhone(d) { d = d.slice(0, 10); return d.length > 5 ? d.slice(0, 5) + ' ' + d.slice(5) : d; }

  /* ---------- Navigation ---------- */
  function show(step, opts) {
    opts = opts || {};
    var prev = current;
    if (prev === step) return;
    $$('.step', form).forEach(function (s) { s.hidden = true; s.classList.remove('enter', 'enter-back'); });
    var el = $('[data-step="' + step + '"]', form);
    el.hidden = false;
    void el.offsetWidth;
    var backwards = prev && ORDER[step] < ORDER[prev];
    el.classList.add(backwards ? 'enter-back' : 'enter');
    current = step;

    var n = ORDER[step];
    var inFlow = step === '1' || step === '2' || step === '3';
    top.classList.toggle('is-hidden', !inFlow);
    backBtn.hidden = !(step === '2' || step === '3');
    $$('span', progress).forEach(function (s, i) { s.classList.toggle('on', i < n); });
    progress.setAttribute('aria-valuenow', String(Math.min(n, 3)));
    count.textContent = Math.min(n, 3) + ' of 3';

    if (step !== 'none') stopRedirect();
    if (opts.push !== false && window.history && history.pushState) { history.pushState({ step: step }, '', location.pathname + location.search); depth++; }
    if (opts.focus !== false) {
      var target = step === '2' ? nameEl : step === 'done' ? $('#qd') : $('h1', el);
      if (target) setTimeout(function () { try { target.focus({ preventScroll: true }); } catch (e) {} }, step === '2' && matchMedia('(pointer: coarse)').matches ? 0 : 60);
    }
    window.scrollTo(0, 0);
    if (step === 'done') write(session, DRAFT_KEY, null); else saveDraft();
  }

  window.addEventListener('popstate', function (ev) {
    depth = Math.max(0, depth - 1);
    var to = ev.state && ev.state.step;
    if (current === 'done') { history.pushState({ step: 'done' }, '', location.pathname + location.search); depth++; return; }
    if (!to) to = '1';
    if (to === '2' && !roleOk()) to = '1';
    if (to === '3' && !detailsOk(false)) to = roleOk() ? '2' : '1';
    if (to === 'done') to = '3';
    show(to, { push: false });
  });

  backBtn.addEventListener('click', function () {
    if (depth > 0) history.back();
    else show(current === '3' ? '2' : '1', { push: false });
  });

  /* ---------- Step 1 ---------- */
  function roleOk() { return state.role === 'doctor' || state.role === 'owner'; }
  var advanceTimer = null;
  var picked = '';
  $$('input[name=role]').forEach(function (r) {
    r.addEventListener('change', function () { choose(r.value); });
    // Clicking the already-selected option should still move on.
    r.closest('label').addEventListener('click', function () { if (r.checked && picked === r.value && current === '1') choose(r.value); });
  });
  function choose(value) {
    picked = value;
    state.role = value === 'none' ? '' : value;
    hideError('role');
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(function () {
      if (value === 'none') { show('none'); startRedirect(); }
      else show('2');
    }, 260);
  }

  /* ---------- Not for you: countdown then redirect ---------- */
  var redirectTimer = null;
  function startRedirect() {
    var left = REDIRECT_SECONDS;
    var out = $('[data-countdown]');
    var ring = $('.ring');
    out.textContent = left;
    ring.classList.remove('run'); void ring.offsetWidth; ring.classList.add('run');
    stopRedirect(true);
    redirectTimer = setInterval(function () {
      left -= 1;
      out.textContent = Math.max(left, 0);
      if (left <= 0) { stopRedirect(true); write(session, DRAFT_KEY, null); location.assign(REDIRECT_URL); }
    }, 1000);
  }
  function stopRedirect(keepRing) { clearInterval(redirectTimer); redirectTimer = null; if (!keepRing) { var ring = $('.ring'); ring && ring.classList.remove('run'); } }
  $('[data-change-answer]').addEventListener('click', function () {
    stopRedirect();
    $$('input[name=role]').forEach(function (r) { r.checked = false; });
    state.role = ''; picked = '';
    show('1');
  });
  document.addEventListener('visibilitychange', function () {
    // Don't send someone away while they're not looking; restart when they return.
    if (current !== 'none') return;
    if (document.hidden) stopRedirect(); else startRedirect();
  });

  /* ---------- Step 2 ---------- */
  function setError(key, msg) {
    var p = $('[data-error="' + key + '"]');
    if (!p) return;
    p.textContent = msg; p.hidden = false;
    var field = p.closest('.field'); if (field) field.classList.add('invalid');
    var input = field && $('input', field); if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', p.id || (p.id = 'err-' + key)); }
  }
  function hideError(key) {
    var p = $('[data-error="' + key + '"]');
    if (!p) return;
    p.hidden = true;
    var field = p.closest('.field'); if (field) field.classList.remove('invalid');
    var input = field && $('input', field); if (input) input.removeAttribute('aria-invalid');
  }
  function detailsOk(showErrors) {
    var ok = true, first = null;
    var name = nameEl.value.replace(/\s+/g, ' ').trim();
    var ph = digits(phoneEl.value);
    var clinic = clinicEl.value.replace(/\s+/g, ' ').trim();
    if (name.length < 2 || !/[A-Za-zÀ-￿]/.test(name)) { ok = false; first = first || nameEl; showErrors && setError('name', 'Enter your name.'); } else hideError('name');
    if (!/^[6-9]\d{9}$/.test(ph)) { ok = false; first = first || phoneEl; showErrors && setError('phone', ph.length ? 'Enter a valid 10-digit mobile number.' : 'Enter your mobile number.'); } else hideError('phone');
    if (clinic.length < 2) { ok = false; first = first || clinicEl; showErrors && setError('clinic', "Enter your clinic's name."); } else hideError('clinic');
    state.name = name; state.phone = ph; state.clinic = clinic;
    if (!ok && showErrors && first) first.focus();
    return ok;
  }
  phoneEl.addEventListener('input', function () {
    var d = digits(phoneEl.value);
    var f = fmtPhone(d);
    if (phoneEl.value !== f) phoneEl.value = f;
  });
  [nameEl, phoneEl, clinicEl].forEach(function (el, i, all) {
    el.addEventListener('input', function () {
      if (el.closest('.field').classList.contains('invalid')) detailsOk(false) || null;
      if (el === nameEl) state.name = el.value; if (el === clinicEl) state.clinic = el.value; if (el === phoneEl) state.phone = digits(el.value);
      saveDraft();
    });
    el.addEventListener('blur', function () { if (el.value.trim()) detailsOk(false); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      if (i < all.length - 1) all[i + 1].focus(); else next();
    });
  });
  function next() { if (detailsOk(true)) show('3'); }
  $('[data-next]').addEventListener('click', next);

  /* ---------- Step 3 ---------- */
  function syncOutcomes() {
    state.outcomes = chips.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
    var n = state.outcomes.length;
    $('[data-picked]').textContent = n === 0 ? 'Nothing selected yet' : n === 1 ? '1 selected' : n + ' selected';
    var all = $('[data-select-all]');
    all.textContent = n === chips.length ? 'Clear all' : 'Select all';
    if (n) hideError('outcomes');
    saveDraft();
  }
  chips.forEach(function (c) { c.addEventListener('change', syncOutcomes); });
  $('[data-select-all]').addEventListener('click', function () {
    var allOn = chips.every(function (c) { return c.checked; });
    chips.forEach(function (c) { c.checked = !allOn; });
    syncOutcomes();
  });

  /* ---------- Submit ---------- */
  function payload() {
    var p = {
      role: state.role, name: state.name, phone: state.phone, clinic: state.clinic, outcomes: state.outcomes.slice(),
      rc_hp: form.elements.rc_hp.value, elapsed_ms: Date.now() - startedAt
    };
    for (var k in attr) p[k] = attr[k];
    return p;
  }

  function withTimeout(promise) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, TIMEOUT_MS);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  function sendToFunction(p) {
    return withTimeout(fetch('/api/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p), keepalive: true }))
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) {
          if (r.ok && body.ok) return { ok: true, reference: body.reference };
          if (r.status === 422) return { ok: false, invalid: body.errors || {} };
          throw new Error('status ' + r.status);
        });
      });
  }

  function sendToNetlifyForms(p) {
    var data = new URLSearchParams();
    data.append('form-name', 'pilot-application');
    data.append('role', p.role === 'doctor' ? 'Doctor' : 'Clinic owner');
    data.append('name', p.name);
    data.append('phone', '+91' + p.phone);
    data.append('clinic', p.clinic);
    data.append('outcomes', p.outcomes.map(function (o) { return LABELS[o]; }).join(', '));
    data.append('rc_hp', p.rc_hp);
    return withTimeout(fetch('/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: data.toString() }))
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return { ok: true }; });
  }

  // Resolves with { ok, reference } once at least one store has it; rejects if both fail.
  function deliver(p) {
    return new Promise(function (resolve, reject) {
      var settled = 0, done = false, invalid = null, reference = '', fnFailed = false, formsOk = false;
      function finish() {
        if (++settled < 2 || done) return;
        done = true;
        if (invalid) reject({ invalid: invalid }); else reject(new Error('both failed'));
      }
      sendToFunction(p).then(function (r) {
        if (r.ok) { reference = r.reference; if (!done) { done = true; resolve({ ok: true, reference: reference }); } }
        else { invalid = r.invalid; finish(); }
      }, function () { fnFailed = true; if (formsOk && !done) { done = true; resolve({ ok: true, reference: '' }); } else finish(); });
      // Give the function a moment to return a reference before accepting the backup alone.
      sendToNetlifyForms(p).then(function () {
        formsOk = true;
        if (fnFailed && !done) { done = true; resolve({ ok: true, reference: '' }); return; }
        setTimeout(function () { if (!done) { done = true; resolve({ ok: true, reference: reference }); } }, 2500);
      }, finish);
    });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (current !== '3') { if (current === '2') next(); return; }
    hideError('form');
    if (!roleOk()) { show('1'); return; }
    if (!detailsOk(true)) { show('2'); detailsOk(true); return; }
    if (!state.outcomes.length) { setError('outcomes', 'Choose at least one thing you want RedClinic to do.'); return; }

    var p = payload();
    submitBtn.classList.add('is-busy');
    submitBtn.setAttribute('aria-busy', 'true');
    $('.btn-label', submitBtn).textContent = 'Submitting…';

    deliver(p).then(function (res) {
      write(local, PENDING_KEY, null);
      succeed(res.reference);
    }, function (err) {
      submitBtn.classList.remove('is-busy');
      submitBtn.removeAttribute('aria-busy');
      $('.btn-label', submitBtn).textContent = 'Submit Application';
      if (err && err.invalid) {
        if (err.invalid.name || err.invalid.phone || err.invalid.clinic) { show('2'); detailsOk(true); return; }
        if (err.invalid.role) { show('1'); return; }
        setError('form', 'Please check your answers and try again.');
        return;
      }
      write(local, PENDING_KEY, p);
      setError('form', "We couldn't send your application. Check your internet and tap Submit again. Your answers are saved on this phone.");
    });
  });

  function succeed(reference) {
    $('[data-r-clinic]').textContent = state.clinic;
    $('[data-r-ref]').textContent = reference || '';
    $('[data-r-ref]').parentNode.hidden = !reference;
    $('[data-receipt]').hidden = false;
    write(local, DONE_KEY, { clinic: state.clinic, reference: reference || '', at: Date.now() });
    write(session, DRAFT_KEY, null);
    show('done');
    if (window.dataLayer) window.dataLayer.push({ event: 'pilot_application_submitted', role: state.role, outcomes: state.outcomes.length });
  }

  $('[data-another]').addEventListener('click', function () {
    write(local, DONE_KEY, null);
    state = { role: state.role, name: state.name, phone: state.phone, clinic: '', outcomes: [] };
    clinicEl.value = '';
    chips.forEach(function (c) { c.checked = false; });
    syncOutcomes();
    submitBtn.classList.remove('is-busy');
    $('.btn-label', submitBtn).textContent = 'Submit Application';
    startedAt = Date.now();
    show('1');
  });

  /* ---------- Start ---------- */
  // 1. An application that failed to send last time: try again quietly.
  var pending = read(local, PENDING_KEY);
  if (pending) {
    deliver(pending).then(function (res) {
      write(local, PENDING_KEY, null);
      write(local, DONE_KEY, { clinic: pending.clinic, reference: res.reference || '', at: Date.now() });
    }, function () {});
  }

  // 2. Restore answers after a refresh.
  var draft = read(session, DRAFT_KEY);
  var doneBefore = read(local, DONE_KEY);
  if (draft && draft.s) {
    state = draft.s;
    $$('input[name=role]').forEach(function (r) { r.checked = r.value === state.role; });
    picked = state.role;
    nameEl.value = state.name || '';
    phoneEl.value = fmtPhone(state.phone || '');
    clinicEl.value = state.clinic || '';
    chips.forEach(function (c) { c.checked = (state.outcomes || []).indexOf(c.value) !== -1; });
  }
  syncOutcomes();

  var startStep = '1';
  if (draft && draft.step === '2' && roleOk()) startStep = '2';
  if (draft && draft.step === '3' && roleOk() && detailsOk(false)) startStep = '3';
  // 3. Already applied from this device (and not mid-way through another one): show the confirmation.
  if (doneBefore && !(draft && draft.s && (draft.s.role || draft.s.clinic))) {
    state.clinic = doneBefore.clinic || '';
    $('[data-r-clinic]').textContent = state.clinic;
    $('[data-r-ref]').textContent = doneBefore.reference || '';
    $('[data-r-ref]').parentNode.hidden = !doneBefore.reference;
    $('[data-receipt]').hidden = !state.clinic;
    startStep = 'done';
  }

  if (window.history && history.replaceState) history.replaceState({ step: startStep }, '', location.pathname + location.search);
  show(startStep, { push: false, focus: false });
})();
