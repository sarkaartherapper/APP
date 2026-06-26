import { ROLES } from '../../lib/roles';

export default function RolesPage() {
  return (
    <section className='page active team-page'>
      <div className='page-header'>
        <h1 className='page-title'>Roles</h1>
        <p className='page-sub'>Use consistent Owner, Admin, Developer, and Viewer permissions when inviting or editing members.</p>
      </div>
      <div className='roles-grid'>
        {ROLES.map((role) => (
          <div className='card role-card' key={role.id}>
            <div className='card-header'>
              <div>
                <div className='card-title'>{role.label}</div>
                <div className='card-sub'>{role.description}</div>
              </div>
              <span className={`badge ${role.tone}`}>{role.id}</span>
            </div>
            <ul className='permission-list'>
              {role.permissions.map((permission) => <li key={permission}>{permission}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
