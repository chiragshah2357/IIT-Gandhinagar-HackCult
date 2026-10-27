/*
 * LiFE City landing page behaviour. Three small jobs, all optional: the page reads fine without any of them.
 *   1. Run a clock down the page and move a marker on the time rail, so scrolling reads as a day passing.
 *   2. Ease sections in once as they arrive.
 *   3. Mount the live 3D scene behind the headline, and pause it when it is off screen.
 */
(() => {
  'use strict';

  const root = document.documentElement;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  root.classList.add('js');

  /* ---------- 1. time rail and clock ---------- */

  // The same carbon curve the app draws, so the rail is a miniature of the app's chart strip.
  const bell = (t, m, s) => {
    let d = Math.abs(t - m);
    d = Math.min(d, 24 - d);
    return Math.exp((-d * d) / (2 * s * s));
  };
  const carbon = (h) =>
    clamp(0.55 - 0.4 * bell(h, 12.5, 3) + 0.42 * bell(h, 20, 1.8) - 0.12 * bell(h, 3, 2.5), 0, 1);
  const RAMP = [
    [111, 168, 220],
    [224, 169, 59],
    [200, 69, 43],
  ];
  const mix = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
  const rampAt = (k) => (k < 0.5 ? mix(RAMP[0], RAMP[1], k * 2) : mix(RAMP[1], RAMP[2], (k - 0.5) * 2));

  const track = document.getElementById('railTrack');
  if (track) {
    const stops = [];
    for (let h = 0; h <= 24; h++) {
      stops.push(`rgb(${rampAt(carbon(h)).join(',')}) ${((h / 24) * 100).toFixed(1)}%`);
    }
    track.style.background = `linear-gradient(to bottom, ${stops.join(',')})`;
  }

  const clock = document.getElementById('clock');
  const mark = document.getElementById('railMark');
  const stops = Array.from(document.querySelectorAll('[data-hour]')).map((el) => ({
    el,
    hour: Number(el.dataset.hour),
    theme: (el.className.match(/\bt-(\w+)/) || [])[1] || 'night',
  }));

  const hhmm = (h) => {
    const m = Math.floor(((h * 60) % 1440) / 5) * 5;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };

  let queued = false;
  const update = () => {
    queued = false;
    const y = window.scrollY + window.innerHeight * 0.35;
    const tops = stops.map((s) => s.el.getBoundingClientRect().top + window.scrollY);
    // The first stop is midnight at the very top of the page, so the clock starts at 00:00.
    tops[0] = window.innerHeight * 0.35;
    let i = 0;
    for (let k = 0; k < stops.length; k++) if (y >= tops[k]) i = k;
    const next = stops[i + 1];
    const end = next ? tops[i + 1] : document.documentElement.scrollHeight;
    const f = clamp((y - tops[i]) / Math.max(1, end - tops[i]), 0, 1);
    const h = stops[i].hour + ((next ? next.hour : 24) - stops[i].hour) * f;
    if (clock) clock.textContent = hhmm(h);
    if (mark) mark.style.top = (clamp(h / 24, 0, 1) * 100).toFixed(2) + '%';
    document.body.dataset.time = stops[i].theme;
  };
  const queue = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  update();

  /* ---------- 2. sections ease in ---------- */

  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const seen = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add('in');
          seen.unobserve(e.target);
        });
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.04 },
    );
    reveals.forEach((el) => seen.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }

  /* ---------- 3. the live scene behind the headline ---------- */

  const scene = document.querySelector('[data-scene]');
  const wide = window.matchMedia('(min-width: 54rem)').matches;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);

  // Phones, reduced motion and data saver keep the still image. Everyone else gets the real scene.
  if (scene && wide && !calm && !saveData) {
    const frame = document.createElement('iframe');
    frame.className = 'hero__frame';
    frame.src = 'app/?embed=1&campus=mujaipur';
    frame.title = 'The campus in 3D, playing a day';
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    scene.append(frame);

    // The app says when it has drawn its first frame, so a failed WebGL start never covers the still.
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
      if (e.data && e.data.type === 'lifecity:ready') frame.classList.add('on');
    });

    new IntersectionObserver(
      ([entry]) => {
        if (!frame.contentWindow) return;
        const type = entry.isIntersecting ? 'lifecity:play' : 'lifecity:pause';
        frame.contentWindow.postMessage({ type }, location.origin);
      },
      { threshold: 0.02 },
    ).observe(scene);
  }
})();
