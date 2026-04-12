(() => {
  const dropdown = document.getElementById('tools-dropdown');
  const toggle = document.getElementById('tools-toggle');
  const menu = document.getElementById('tools-menu');
  if (!dropdown || !toggle || !menu) return;

  dropdown.classList.add('home-tools-dropdown');
  menu.classList.add('home-tools-menu');
  menu.classList.remove('w-[290px]');

  if (!menu.querySelector('.home-tools-grid')) {
    const items = [
      {
        href: '/tools/clip-discovery.html',
        title: 'Clip Discovery',
        desc: 'Fetch and review incoming clips fast.',
        icon: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="3"/></svg>',
      },
      {
        href: '/tools/approval-workflow.html',
        title: 'Approval Workflow',
        desc: 'Move fast through pending and approved decisions.',
        icon: '<svg viewBox="0 0 24 24"><path d="M5 12l4 4L19 6"/><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
      },
      {
        href: '/tools/upload-edit-studio.html',
        title: 'Upload Edit Studio',
        desc: 'Set camera and gameplay layout precisely.',
        icon: '<svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M9 9h6M9 13h4M7 3v4M17 3v4"/></svg>',
      },
      {
        href: '/tools/split-zoom-timeline.html',
        title: 'Split + Zoom Timeline',
        desc: 'Cut dead air and highlight key moments.',
        icon: '<svg viewBox="0 0 24 24"><path d="M3 12h18"/><path d="M8 6v12M16 6v12"/><path d="M12 8v8"/></svg>',
      },
      {
        href: '/tools/tiktok-output-preview.html',
        title: 'TikTok Output Preview',
        desc: 'Validate your final 9:16 composition.',
        icon: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2"/><path d="M10 7h4M10 11h4M10 15h4"/></svg>',
      },
      {
        href: '/tools/bulk-upload-queue.html',
        title: 'Bulk Upload Queue',
        desc: 'Batch upload with pause, resume, and cancel.',
        icon: '<svg viewBox="0 0 24 24"><path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><rect x="4" y="16" width="16" height="4" rx="1"/></svg>',
      },
      {
        href: '/tools/emote-generator.html',
        title: 'Emote Generator',
        desc: 'Build Twitch-ready emotes from clip moments.',
        icon: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="10" cy="11" r="1"/><circle cx="14" cy="11" r="1"/><path d="M9 15c1 .9 2 .9 3 .9s2 0 3-.9"/></svg>',
      },
      {
        href: '/tools/admin-streamer-management.html',
        title: 'Admin + Streamers',
        desc: 'Manage streamers and admin controls in one place.',
        icon: '<svg viewBox="0 0 24 24"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="8" r="2.5"/><path d="M3 19c1.2-2.3 3-3.5 5-3.5s3.8 1.2 5 3.5"/><path d="M13.5 18.5c.8-1.6 2-2.4 3.5-2.4 1.4 0 2.6.8 3.4 2.4"/></svg>',
      },
    ];

    menu.innerHTML = `<div class="home-tools-grid">${items.map((item) => `
      <a class="home-tools-item" href="${item.href}">
        <span class="home-tools-item-icon" aria-hidden="true">${item.icon}</span>
        <span class="home-tools-item-copy">
          <span class="home-tools-item-title">${item.title}</span>
          <span class="home-tools-item-desc">${item.desc}</span>
        </span>
      </a>
    `).join('')}</div>`;
  }

  const ctaButton = document.querySelector('header a[href="/login"]');
  if (ctaButton) {
    ctaButton.classList.add('tool-cta-bright');
  }

  let closeTimer = null;
  const clearCloseTimer = () => {
    if (!closeTimer) return;
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const setDropdown = (open) => {
    const next = !!open;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    menu.classList.toggle('open', next);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      setDropdown(false);
    }, 220);
  };

  dropdown.addEventListener('mouseenter', () => {
    clearCloseTimer();
    setDropdown(true);
  });

  dropdown.addEventListener('mouseleave', () => {
    scheduleClose();
  });

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    clearCloseTimer();
    setDropdown(!menu.classList.contains('open'));
  });

  toggle.addEventListener('focus', () => {
    clearCloseTimer();
    setDropdown(true);
  });

  menu.addEventListener('mouseenter', () => {
    clearCloseTimer();
  });

  menu.addEventListener('mouseleave', () => {
    scheduleClose();
  });

  document.addEventListener('click', (event) => {
    if (!dropdown.contains(event.target)) {
      clearCloseTimer();
      setDropdown(false);
    }
  });

  menu.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      clearCloseTimer();
      setDropdown(false);
    });
  });
})();
