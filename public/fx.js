/* ak47bot — effets d'interface (purement cosmétiques) */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const app = document.getElementById('app');

  /* halo qui suit le curseur sur les cartes */
  if (!reduce) {
    let raf = 0;
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest('.card, .stat');
      if (!el || raf) return;
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        el.style.setProperty('--my', (e.clientY - r.top) + 'px');
        raf = 0;
      });
    }, { passive: true });
  }

  /* effet d'onde au clic sur les boutons */
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest && e.target.closest('.btn');
    if (!b || b.disabled || reduce) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const s = document.createElement('span');
    s.className = 'rip';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    b.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  /* compteurs animés sur les statistiques */
  const ease = (t) => 1 - Math.pow(1 - t, 4);
  function countUp(el) {
    if (el.dataset.fx) return;
    el.dataset.fx = '1';
    const raw = el.textContent.trim();
    if (!/^\d[\d\s\u00a0\u202f]*$/.test(raw)) return;
    const target = parseInt(raw.replace(/\D/g, ''), 10);
    if (!Number.isFinite(target) || target < 2) return;
    const grouped = /[\s\u00a0\u202f]/.test(raw);
    const fmt = (n) => (grouped ? n.toLocaleString('fr-FR') : String(n));
    const t0 = performance.now(), dur = Math.min(1200, 500 + target * 2);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(Math.round(target * ease(p)));
      if (p < 1) requestAnimationFrame(step); else el.textContent = raw;
    };
    el.textContent = fmt(0);
    requestAnimationFrame(step);
  }
  if (app && !reduce) {
    const scan = () => app.querySelectorAll('.stat b').forEach(countUp);
    new MutationObserver(scan).observe(app, { childList: true, subtree: true });
    scan();
  }
})();
