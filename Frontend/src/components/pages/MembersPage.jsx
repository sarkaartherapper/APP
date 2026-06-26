import { useEffect, useState } from 'react';
import { ASSIGNABLE_ROLES, roleMeta } from '../../lib/roles';

export default function MembersPage({ ctx }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('developer');
  const [busy, setBusy] = useState('');

  useEffect(() => { ctx.loadMembers?.().catch((e) => ctx.notify(e.message, 'error')); }, []);

  const invite = async () => {
    setBusy('invite');
    try {
      await ctx.inviteMember(email, role);
      setEmail(''); setRole('developer');
    } catch (e) { ctx.notify(e.message, 'error'); }
    finally { setBusy(''); }
  };

  const changeRole = async (member, nextRole) => {
    setBusy(member.id);
    try { await ctx.updateMemberRole(member.id, nextRole); }
    catch (e) { ctx.notify(e.message, 'error'); }
    finally { setBusy(''); }
  };

  const remove = async (member) => {
    if (!confirm(`Remove ${member.email || member.name} from this workspace?`)) return;
    setBusy(member.id);
    try { await ctx.removeMember(member.id); }
    catch (e) { ctx.notify(e.message, 'error'); }
    finally { setBusy(''); }
  };

  return (
    <section className='page active team-page'>
      <div className='page-header'>
        <h1 className='page-title'>Team Members</h1>
        <p className='page-sub'>Manage teammates on Lethem and send invites when someone is not already in your workspace.</p>
      </div>
      <div className='card invite-card'>
        <div className='card-header'><div><div className='card-title'>Invite a teammate</div><div className='card-sub'>If the user is not on Lethem, send them an email invitation powered by Resend.</div></div></div>
        <div className='invite-form'>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder='teammate@example.com' type='email' />
          <select value={role} onChange={(e) => setRole(e.target.value)}>{ASSIGNABLE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          <button className='btn btn-primary' disabled={busy === 'invite' || !email} onClick={invite}>{busy === 'invite' ? 'Sending…' : 'Send An Invite'}</button>
        </div>
      </div>
      <div className='card'>
        <div className='card-header'><div><div className='card-title'>Current members</div><div className='card-sub'>{ctx.members.length} teammate{ctx.members.length === 1 ? '' : 's'} in this workspace</div></div></div>
        {ctx.teamLoading ? <div className='empty'>Loading members…</div> : ctx.members.length === 0 ? <div className='empty'><div className='empty-text'>No members yet.</div></div> : (
          <div className='table-wrap team-table-wrap'><table><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th>Actions</th></tr></thead><tbody>{ctx.members.map((m) => {
            const meta = roleMeta(m.role);
            return <tr key={m.id}><td><div className='member-cell'>{m.picture_url && <img src={m.picture_url} alt='' />}<div><strong>{m.name || m.email || 'Lethem user'}</strong><span>{m.email}{m.is_current_user ? ' · You' : ''}</span></div></div></td><td><span className={`badge ${meta.tone}`}>{meta.label}</span></td><td>{ctx.fmtDate(m.joined_at)}</td><td><div className='row-actions'>{m.role === 'owner' || m.is_current_user ? <span className='muted-text'>Protected</span> : <><select value={m.role} disabled={busy === m.id} onChange={(e) => changeRole(m, e.target.value)}>{ASSIGNABLE_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select><button className='btn btn-danger btn-sm' disabled={busy === m.id} onClick={() => remove(m)}>Remove</button></>}</div></td></tr>;
          })}</tbody></table></div>
        )}
      </div>
    </section>
  );
}
