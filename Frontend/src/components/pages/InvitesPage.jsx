import { useEffect, useState } from 'react';
import { ASSIGNABLE_ROLES, roleMeta } from '../../lib/roles';

export default function InvitesPage({ ctx }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [busy, setBusy] = useState('');
  useEffect(() => { ctx.loadInvites?.().catch((e) => ctx.notify(e.message, 'error')); }, []);
  const send = async () => { setBusy('send'); try { await ctx.inviteMember(email, role); setEmail(''); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); } };
  const revoke = async (invite) => { setBusy(invite.id); try { await ctx.revokeInvite(invite.id); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); } };
  return (
    <section className='page active team-page'>
      <div className='page-header'><h1 className='page-title'>Invites</h1><p className='page-sub'>Track pending email invitations and send another invite to teammates who are not on Lethem yet.</p></div>
      <div className='card invite-card'><div className='card-header'><div><div className='card-title'>Send invite</div><div className='card-sub'>Invites expire after 7 days and become members after sign-in.</div></div></div><div className='invite-form'><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder='teammate@example.com' type='email' /><select value={role} onChange={(e) => setRole(e.target.value)}>{ASSIGNABLE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select><button className='btn btn-primary' disabled={busy === 'send' || !email} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send An Invite'}</button></div></div>
      <div className='card'><div className='card-header'><div><div className='card-title'>Invitation history</div><div className='card-sub'>{ctx.invites.length} invite{ctx.invites.length === 1 ? '' : 's'}</div></div></div>{ctx.teamLoading ? <div className='empty'>Loading invites…</div> : ctx.invites.length === 0 ? <div className='empty'><div className='empty-text'>No invites sent yet.</div></div> : <div className='table-wrap team-table-wrap'><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{ctx.invites.map((i) => <tr key={i.id}><td>{i.email}</td><td><span className={`badge ${roleMeta(i.role).tone}`}>{roleMeta(i.role).label}</span></td><td><span className={`badge ${i.status === 'pending' ? 'paused' : i.status === 'accepted' ? 'active' : 'revoked'}`}>{i.status}</span></td><td>{ctx.fmtDate(i.expires_at)}</td><td>{i.status === 'pending' ? <button className='btn btn-danger btn-sm' disabled={busy === i.id} onClick={() => revoke(i)}>Revoke</button> : <span className='muted-text'>—</span>}</td></tr>)}</tbody></table></div>}</div>
    </section>
  );
}
