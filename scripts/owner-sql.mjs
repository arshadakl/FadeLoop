const quote = value => `'${value.replaceAll("'", "''")}'`;
export function ownerSql(action, email, hash, now) {
  if (action === 'create') return `INSERT INTO owner_accounts (id, email, password_hash, updated_at) VALUES (1, ${quote(email)}, ${quote(hash)}, ${now});`;
  if (action !== 'reset') throw new Error('Unknown owner action');
  return `UPDATE owner_accounts SET password_hash = ${quote(hash)}, credential_version = credential_version + 1, updated_at = ${now} WHERE id = 1 AND email = ${quote(email)};
    DELETE FROM owner_sessions WHERE credential_version != (SELECT credential_version FROM owner_accounts WHERE id = 1);
    DELETE FROM owner_oauth_states WHERE session_hash NOT IN (SELECT token_hash FROM owner_sessions);
    DELETE FROM login_throttles WHERE EXISTS (SELECT 1 FROM owner_accounts WHERE email = ${quote(email)} AND updated_at = ${now});`;
}
