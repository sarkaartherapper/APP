import { useEffect, useState } from 'react';
import { ASSIGNABLE_ROLES, roleMeta } from '../../lib/roles';

export default function InvitesPage({ ctx }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [busy, setBusy] = useState('');
  useEffect(() => { ctx.loadInvites?.().catch((e) => ctx.notify(e.message, 'error')); }, []);
  const send = async () => { setBusy('send'); try { await ctx.inviteMember(email, role); setEmail(''); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); } };
  const revoke = async (invite) => { setBusy(invite.id); try { await ctx.revokeInvite(invite.id); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); } };
  const accept = async (invite) => { setBusy(invite.id); try { await ctx.acceptInvite(invite.id); } catch (e) { ctx.notify(e.message, 'error'); } finally { setBusy(''); } };
  const received = ctx.invites.filter((invite) => invite.direction === 'received');
  const sent = ctx.invites.filter((invite) => invite.direction !== 'received');
  const renderRows = (rows, mode) => rows.map((i) => <tr key={`${mode}-${i.id}`}><td>{mode === 'received' ? i.organization_name : i.email}</td><td><span className={`badge ${roleMeta(i.role).tone}`}>{roleMeta(i.role).label}</span></td><td><span className={`badge ${i.status === 'pending' ? 'paused' : i.status === 'accepted' ? 'active' : 'revoked'}`}>{i.status}</span></td><td>{ctx.fmtDate(i.expires_at)}</td><td>{mode === 'received' && i.can_accept ? <button className='btn btn-primary btn-sm' disabled={busy === i.id} onClick={() => accept(i)}>Accept</button> : mode === 'sent' && i.status === 'pending' ? <button className='btn btn-danger btn-sm' disabled={busy === i.id} onClick={() => revoke(i)}>Revoke</button> : <span className='muted-text'>—</span>}</td></tr>);
  return (
    <section className='page active team-page'>
      <div className='page-header'><h1 className='page-title'>Invites</h1><p className='page-sub'>Accept workspace invites sent to you, or track invites you sent from this workspace.</p></div>
      <div className='card invite-card'><div className='card-header'><div><div className='card-title'>Send invite</div><div className='card-sub'>Existing users receive in-app invites. New users receive email invite links.</div></div></div><div className='invite-form'><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder='teammate@example.com' type='email' /><select value={role} onChange={(e) => setRole(e.target.value)}>{ASSIGNABLE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select><button className='btn btn-primary' disabled={busy === 'send' || !email} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send An Invite'}</button></div></div>
      <div className='card'><div className='card-header'><div><div className='card-title'>Invites for you</div><div className='card-sub'>{received.length} invite{received.length === 1 ? '' : 's'} waiting for this account</div></div></div>{ctx.teamLoading ? <div className='empty'>Loading invites…</div> : received.length === 0 ? <div className='empty'><div className='empty-text'>No incoming invites.</div></div> : <div className='table-wrap team-table-wrap'><table><thead><tr><th>Workspace</th><th>Role</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{renderRows(received, 'received')}</tbody></table></div>}</div>
      <div className='card'><div className='card-header'><div><div className='card-title'>Sent invitation history</div><div className='card-sub'>{sent.length} invite{sent.length === 1 ? '' : 's'} sent from this workspace</div></div></div>{ctx.teamLoading ? <div className='empty'>Loading invites…</div> : sent.length === 0 ? <div className='empty'><div className='empty-text'>No invites sent yet.</div></div> : <div className='table-wrap team-table-wrap'><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th>Actions</th></tr></thead><tbody>{renderRows(sent, 'sent')}</tbody></table></div>}</div>
    </section>
  );
}
