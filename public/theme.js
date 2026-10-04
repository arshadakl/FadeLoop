// Runs before CSS on every page, including public legal pages.
(() => {
  const key = 'fadeloop_theme';
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem(key) || 'system'; } catch {}
  if (!['light', 'dark', 'system'].includes(preference)) preference = 'system';
  const apply = () => {
    document.documentElement.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
  };
  window.fadeTheme = {
    get: () => preference,
    set: value => { preference = ['light', 'dark', 'system'].includes(value) ? value : 'system'; try { localStorage.setItem(key, preference); } catch {} apply(); },
  };
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => { if (event.key === key) { preference = event.newValue || 'system'; apply(); } });
  apply();
})();
