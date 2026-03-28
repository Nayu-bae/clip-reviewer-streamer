(() => {
  const dropdown = document.getElementById('tools-dropdown');
  const toggle = document.getElementById('tools-toggle');
  const menu = document.getElementById('tools-menu');
  if (!dropdown || !toggle || !menu) return;

  const setDropdown = (open) => {
    const next = !!open;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    menu.classList.toggle('open', next);
  };

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    setDropdown(!menu.classList.contains('open'));
  });

  document.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) setDropdown(false);
  });

  menu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setDropdown(false));
  });
})();
