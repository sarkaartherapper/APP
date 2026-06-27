import { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { cacheGet, cacheSet, cacheBust, cacheBustAfterMutation, cachePruneExpired, setCacheScope } from '../lib/cache';
import { useAuth } from './AuthContext';
import { API_BASE_URL } from '../lib/config';

const CTX = createContext(null);
export const useLethem = () => useContext(CTX);

const API = API_BASE_URL;
export const fmtNum = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
export const fmtTime = (ts) => (!ts ? '—' : new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
export const fmtDate = (ts) => (!ts ? 'Never' : new Date(ts * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
export const quotaColor = (used, limit) => (((used / limit) * 100 > 90) ? 'over' : ((used / limit) * 100 > 70) ? 'warn' : 'ok');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const VALID_PAGES = ['overview', 'masterkeys', 'subkeys', 'logs', 'demo', 'health', 'notifications', 'billing', 'analytics', 'members', 'roles', 'invites', 'usage', 'subscription', 'invoices', 'general', 'endpoint', 'security', 'audit', 'danger', 'profile', 'workspace', 'docs'];

export default function LethemProvider({ children, projectSlug, page }) {
  const { getAccessToken, isAuthenticated, user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [showPlanBanner, setShowPlanBanner] = useState(true);
  const [subkeys, setSubkeys] = useState([]);
  const [masterKeys, setMasterKeys] = useState([]);
  const [logs, setLogs] = useState([]);
  const [analytics, setAnalytics] = useState({ totalRequests: 0, totalTokens: 0, avgLatency: '—', logs: [] });
  const [notif, setNotif] = useState({ show: false, msg: '', type: 'success' });
  const [modal, setModal] = useState('');
  const [revealedToken, setRevealedToken] = useState('—');
  const [providers, setProviders] = useState([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState({ overview: true, masterkeys: true, subkeys: true, logs: true });
  const [copiedItem, setCopiedItem] = useState('');
  const [billing, setBilling] = useState(null);
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);

  const notify = (msg, type = 'success') => { setNotif({ show: true, msg, type }); setTimeout(() => setNotif((v) => ({ ...v, show: false })), 3000); };

  useEffect(() => {
    setCacheScope(isAuthenticated && user?.sub ? user.sub : 'public');
    cachePruneExpired();
  }, [isAuthenticated, user?.sub]);

  const copyText = async (text, id = '') => {
    try {
      await navigator.clipboard.writeText(text);
      if (id) { setCopiedItem(id); setTimeout(() => setCopiedItem((v) => v === id ? '' : v), 1600); }
      else notify('Copied to clipboard');
    } catch { notify('Failed to copy', 'error'); }
  };

  const api = async (path, opts = {}) => {
    const hasBody = opts.body !== undefined;
    const method = (opts.method || 'GET').toUpperCase();
    const isRead = method === 'GET';
    const noCache = Boolean(opts.noCache);
    const headers = {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(projectSlug ? { 'x-project-id': projectSlug } : {}),
      ...opts.headers
    };
    const skipAuth = Boolean(opts.skipAuth || opts.headers?.Authorization);
    const cacheScope = skipAuth ? 'public' : (user?.sub || 'anonymous');
    if (!skipAuth && isAuthenticated) {
      headers.Authorization = `Bearer ${await getAccessToken()}`;
    }
    delete opts.skipAuth;
    delete opts.noCache;

    // Return cached GET data if fresh
    if (isRead && !noCache) {
      const cached = cacheGet(path, cacheScope);
      if (cached !== null) return cached;
    }

    const res = await fetch(API + path, { ...opts, method, headers, body: hasBody ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      err.code = data?.error?.code || null;
      throw err;
    }

    // Cache successful reads; bust only real mutations. noCache GETs bypass storage without invalidating.
    if (isRead) {
      if (!noCache) cacheSet(path, data, cacheScope);
    } else {
      cacheBustAfterMutation(path, cacheScope);
    }

    return data;
  };

  const loadProviders = async () => {
    const res = await api('/api/providers', { skipAuth: true });
    setProviders(res.providers || []);
    return res.providers || [];
  };

  const acceptPendingInviteToken = async () => {
    let token = '';
    try { token = sessionStorage.getItem('lethem_pending_invite_token') || ''; } catch (_) {}
    if (!token) return null;
    try {
      const res = await api('/api/invites/accept', { method: 'POST', body: { token } });
      notify('Invite accepted');
      return res;
    } finally {
      try { sessionStorage.removeItem('lethem_pending_invite_token'); } catch (_) {}
    }
  };

  const loadProjects = async () => {
    await acceptPendingInviteToken().catch((e) => notify(e.message, 'error'));
    const rows = await api('/api/projects', { noCache: true });
    setProjects(rows);
    return rows;
  };

  const loadBilling = async ({ refresh = false } = {}) => {
    if (refresh) cacheBust('/api/billing/plans', user?.sub || 'anonymous');
    const data = await api('/api/billing/plans', { noCache: true });
    setBilling(data);
    try {
      const detailOnly = {
        currentPlan: data.currentPlan,
        subscriptionId: data.subscriptionId,
        subscriptionStatus: data.subscriptionStatus,
        currency: data.currency,
        testMode: data.testMode,
        plan: (data.plans || []).find((plan) => plan.id === data.currentPlan) || null,
      };
      localStorage.setItem('lethem_subscription_details', JSON.stringify(detailOnly));
    } catch (_) {}
    return data;
  };

  const loadOverview = async () => {
    setLoading((v) => ({ ...v, overview: true }));
    try {
      const [sks, an] = await Promise.all([api('/api/subkeys'), api('/api/analytics')]);
      setSubkeys(sks);
      setLogs(an.logs || []);
      setAnalytics(an);
      setLoading((v) => ({ ...v, logs: false }));
    } finally {
      setLoading((v) => ({ ...v, overview: false }));
    }
  };

  const loadMasterKeys = async () => {
    setLoading((v) => ({ ...v, masterkeys: true }));
    try { setMasterKeys(await api('/api/master-keys')); }
    finally { setLoading((v) => ({ ...v, masterkeys: false })); }
  };

  const loadSubkeys = async () => {
    setLoading((v) => ({ ...v, subkeys: true }));
    try { setSubkeys(await api('/api/subkeys')); }
    finally { setLoading((v) => ({ ...v, subkeys: false })); }
  };

  const loadLogs = async () => {
    setLoading((v) => ({ ...v, logs: true }));
    try {
      const an = await api('/api/analytics');
      setLogs(an.logs || []);
      setAnalytics(an);
    } finally {
      setLoading((v) => ({ ...v, logs: false }));
    }
  };

  const loadMembers = async () => {
    setTeamLoading(true);
    try { const rows = await api('/api/members', { noCache: true }); setMembers(rows); return rows; }
    finally { setTeamLoading(false); }
  };

  const loadInvites = async () => {
    setTeamLoading(true);
    try { const rows = await api('/api/invites', { noCache: true }); setInvites(rows); return rows; }
    finally { setTeamLoading(false); }
  };

  const checkInvitee = async (email) => {
    try {
      return await api('/api/invites/check', { method: 'POST', body: { email } });
    } catch (err) {
      if (String(err.message || '').toLowerCase().includes('not found')) {
        return api(`/api/invites/check?email=${encodeURIComponent(email)}`, { noCache: true });
      }
      throw err;
    }
  };

  const inviteMember = async (email, role) => {
    const res = await api('/api/invites', { method: 'POST', body: { email, role } });
    notify(res.user_exists ? 'In-app invite sent' : 'Email invite sent');
    await Promise.all([loadMembers().catch(() => []), loadInvites().catch(() => [])]);
    return res;
  };

  const acceptInvite = async (inviteId) => {
    const res = await api('/api/invites/accept', { method: 'POST', body: { inviteId } });
    notify('Invite accepted');
    await Promise.all([loadProjects().catch(() => []), loadInvites().catch(() => [])]);
    return res;
  };

  const updateMemberRole = async (userId, role) => {
    const res = await api(`/api/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } });
    notify('Member role updated');
    await loadMembers();
    return res;
  };

  const removeMember = async (userId) => {
    const res = await api(`/api/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    notify('Member removed');
    await loadMembers();
    return res;
  };

  const revokeInvite = async (inviteId) => {
    const res = await api(`/api/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
    notify('Invite revoked');
    await loadInvites();
    return res;
  };

  const createProject = async (name) => {
    const projectLimit = billing?.plans?.find((plan) => plan.id === billing.currentPlan)?.limits?.projects ?? 3;
    if (projectLimit !== null && projects.length >= projectLimit) { notify(`Maximum ${projectLimit} projects allowed on your current plan`, 'error'); return null; }
    const p = await api('/api/projects', { method: 'POST', body: { name } });
    await loadProjects();
    return p;
  };

  const deleteProject = async (targetProject = projectToDelete) => {
    if (!targetProject) return;
    const ref = encodeURIComponent(targetProject.slug || targetProject.id);
    const attempts = [
      { path: `/api/projects/by-slug/${ref}`, method: 'DELETE' },
      { path: `/api/projects/${encodeURIComponent(targetProject.id)}`, method: 'DELETE' },
    ];
    let deleted = false;
    for (const attempt of attempts) {
      try {
        const data = await api(attempt.path, { method: attempt.method });
        if (data?.success !== false) { deleted = true; break; }
      } catch (_) {}
    }
    if (!deleted) throw new Error('Failed to delete project');
    cacheBust('/api/projects', user?.sub || 'anonymous');
    setDeleteConfirm('');
    setProjectToDelete(null);
    notify('Project deleted');
    const ps = await loadProjects();
    return ps;
  };

  useEffect(() => {
    if (!projectSlug) return;
    if (page === 'overview' || page === 'analytics' || page === 'usage') loadOverview().catch((e) => notify(e.message, 'error'));
    if (page === 'usage') loadBilling().catch(() => {});
    if (page === 'masterkeys') loadMasterKeys().catch((e) => notify(e.message, 'error'));
    if (page === 'subkeys') loadSubkeys().catch((e) => notify(e.message, 'error'));
    if (page === 'logs') loadLogs().catch((e) => notify(e.message, 'error'));
    if (page === 'members') loadMembers().catch((e) => notify(e.message, 'error'));
    if (page === 'invites') loadInvites().catch((e) => notify(e.message, 'error'));
    if (page === 'demo' || page === 'notifications') {
      loadSubkeys().catch((e) => notify(e.message, 'error'));
      setLoading((v) => ({ ...v, subkeys: true }));
    }
  }, [page, projectSlug]);

  // Reset subkey loading when data arrives for demo/notifications
  useEffect(() => {
    if (page === 'members') loadMembers().catch((e) => notify(e.message, 'error'));
    if (page === 'invites') loadInvites().catch((e) => notify(e.message, 'error'));
    if (page === 'demo' || page === 'notifications') {
      if (subkeys.length > 0) setLoading((v) => ({ ...v, subkeys: false }));
    }
  }, [subkeys, page]);

  // Auto-refresh on tab focus — catches external API requests
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!projectSlug) return;
      if (page === 'overview' || page === 'analytics' || page === 'usage') loadOverview().catch(() => {});
      else if (page === 'masterkeys') loadMasterKeys().catch(() => {});
      else if (page === 'subkeys') loadSubkeys().catch(() => {});
      else if (page === 'logs') loadLogs().catch(() => {});
      else if (page === 'demo' || page === 'notifications') loadSubkeys().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [page, projectSlug]);

  const ctx = useMemo(() => ({
    API, providers, loadProviders, fmtNum, fmtTime, fmtDate, quotaColor, sleep,
    api, notify, copyText, modal, setModal, revealedToken, setRevealedToken,
    loadMasterKeys, loadSubkeys, loadLogs, loadOverview, loadBilling, loadMembers, loadInvites,
    checkInvitee, inviteMember, acceptInvite, updateMemberRole, removeMember, revokeInvite,
    subkeys, setSubkeys, masterKeys, logs, analytics, billing, setBilling, members, invites, teamLoading, page, loading, copiedItem,
    selectedProject: projects.find((p) => p.slug === projectSlug || p.id === projectSlug),
  }), [modal, subkeys, masterKeys, logs, analytics, billing, members, invites, teamLoading, revealedToken, page, projectSlug, providers, loading, copiedItem, isAuthenticated, user?.sub, projects]);

  const value = useMemo(() => ({
    ctx,
    projects, projectName, setProjectName,
    projectSearch, setProjectSearch, projectToDelete, setProjectToDelete,
    deleteConfirm, setDeleteConfirm, showPlanBanner, setShowPlanBanner,
    mobileMenuOpen, setMobileMenuOpen,
    notif,
    createProject, deleteProject, loadProviders, loadProjects, loadBilling, notify, acceptPendingInviteToken,
    filteredProjects: projects.filter((p) =>
      `${p.name} ${p.slug} ${p.id}`.toLowerCase().includes(projectSearch.toLowerCase())
    ),
    selectedProject: projects.find((p) => p.slug === projectSlug || p.id === projectSlug),
  }), [ctx, projects, projectName, projectSearch, projectToDelete, deleteConfirm, showPlanBanner, mobileMenuOpen, notif, projectSlug]);

  return <CTX.Provider value={value}>{children}</CTX.Provider>;
}