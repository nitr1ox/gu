/* ak47bot — effets de la page d'accueil et de la doc */
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = document.querySelector('.top');

  /* barre de progression + en-tête qui se renforce au scroll */
  const bar = document.createElement('div');
  bar.className = 'progress';
  document.body.prepend(bar);
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scrollY / max) : 0})`;
      if (top) top.classList.toggle('scrolled', scrollY > 8);
      ticking = false;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (reduce || !('IntersectionObserver' in window)) return;

  /* apparition progressive des blocs au scroll */
  const targets = document.querySelectorAll('.block > *, .cta > *, .steps li, .features div, .checks li, .split > *, .foot, article > *, section > h2, section > h3');
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  targets.forEach((el) => {
    if (el.closest('.hero') || el.closest('.top')) return;
    const sibs = el.parentElement ? [...el.parentElement.children] : [];
    el.style.setProperty('--d', Math.min(sibs.indexOf(el), 5) * 0.08 + 's');
    el.classList.add('rv');
    io.observe(el);
  });
})();
