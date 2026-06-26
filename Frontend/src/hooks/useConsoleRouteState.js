import { useEffect, useState } from 'react';

export default function useConsoleRouteState() {
  const [page, setPage] = useState('overview');
  const [view, setView] = useState('select');
  const [projectSlug, setProjectSlug] = useState('');
  const [isPublicHealth, setIsPublicHealth] = useState(false);
  const [publicPage, setPublicPage] = useState('');
  const accountPages = new Set(['subscription', 'billing', 'profile', 'workspace', 'docs']);

  const rememberReturnPath = () => {
    const path = `${window.location.pathname}${window.location.search || ''}`;
    try { sessionStorage.setItem('lethem_last_console_path', path); } catch (_) {}
  };

  const parsePath = () => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('code') && params.has('state')) return;

    const publicRoutes = {
      '/': 'landing',
      '/terms-and-conditions': 'terms',
      '/privacy-policy': 'privacy',
      '/refund-and-cancellation-policy': 'refund',
      '/shipping-delivery-policy': 'shipping',
    };

    if (publicRoutes[window.location.pathname]) {
      setPublicPage(publicRoutes[window.location.pathname]);
      setIsPublicHealth(false);
      setView('public');
      setProjectSlug('');
      setPage('overview');
      return;
    }

    if (window.location.pathname.startsWith('/invite/')) {
      const token = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] || '');
      try { sessionStorage.setItem('lethem_pending_invite_token', token); } catch (_) {}
      window.history.replaceState({}, '', '/console');
      return parsePath();
    }

    setPublicPage('');
    if (window.location.pathname === '/health') {
      setIsPublicHealth(true);
      setView('select');
      setProjectSlug('');
      setPage('health');
      return;
    }

    setIsPublicHealth(false);
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'console') {
      window.history.pushState({}, '', '/console');
      return parsePath();
    }
    if (!parts[1]) { rememberReturnPath(); setView('select'); setProjectSlug(''); setPage('overview'); return; }
    if (parts[1] === 'new') { rememberReturnPath(); setView('create'); setProjectSlug(''); setPage('overview'); return; }
    if (accountPages.has(parts[1])) { setView('account'); setProjectSlug(''); setPage(parts[1]); return; }
    rememberReturnPath();
    setView('console');
    setProjectSlug(parts[1]);
    setPage(parts[2] || 'overview');
  };

  const go = (path) => { window.history.pushState({}, '', path); parsePath(); };

  useEffect(() => {
    const h = () => parsePath();
    window.addEventListener('popstate', h);
    parsePath();
    return () => window.removeEventListener('popstate', h);
  }, []);

  return { page, view, projectSlug, go, isPublicHealth, publicPage };
}
