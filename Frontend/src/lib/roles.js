export const ROLES = [
  { id: 'owner', label: 'Owner', tone: 'active', description: 'Full workspace access, billing, team management, and destructive actions.', permissions: ['Manage billing', 'Manage members', 'Manage keys', 'View analytics', 'Delete projects'] },
  { id: 'admin', label: 'Admin', tone: 'active', description: 'Manage projects, keys, usage, and teammates except ownership transfer.', permissions: ['Invite members', 'Manage keys', 'View analytics', 'Manage projects'] },
  { id: 'developer', label: 'Developer', tone: 'paused', description: 'Build and operate API access without billing or team administration.', permissions: ['Create subkeys', 'View logs', 'Run demos', 'View usage'] },
  { id: 'viewer', label: 'Viewer', tone: 'revoked', description: 'Read-only monitoring for logs, analytics, and workspace health.', permissions: ['View analytics', 'View logs', 'View health'] },
];

export const ASSIGNABLE_ROLES = ROLES.filter((role) => role.id !== 'owner');
export const roleMeta = (role) => ROLES.find((item) => item.id === role) || ROLES[3];
