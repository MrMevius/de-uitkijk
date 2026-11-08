// Server-side administration for emergencies and the first administrator.
//
//   docker compose exec server node apps/server/src/cli.ts admin-link <username>
//   docker compose exec server node apps/server/src/cli.ts users
//
// `admin-link` creates the administrator if it does not exist (or promotes an existing user) and prints a
// one-time link to set the password. The link is valid for 72 hours and replaces earlier links.
import { join } from 'node:path';
import { AuthStore, usernameProblem } from './auth/store.ts';

const dataDir = process.env.UITKIJK_DATA_DIR;
const publicUrl = process.env.UITKIJK_PUBLIC_URL;
if (!dataDir || !publicUrl) {
  console.error('UITKIJK_DATA_DIR and UITKIJK_PUBLIC_URL must be set');
  process.exit(2);
}

const store = new AuthStore(join(dataDir, 'uitkijk.db'));
const [command, name] = process.argv.slice(2);

try {
  if (command === 'users') {
    for (const u of store.listUsers()) console.log(`${u.username}\t${u.role}\t${u.active ? 'actief' : 'niet geactiveerd'}`);
  } else if (command === 'admin-link' && name) {
    const username = name.trim().toLowerCase();
    const problem = usernameProblem(username);
    if (problem) throw new Error(problem);
    let user = store.findUser(username) ?? store.createUser(username, 'admin');
    if (user.role !== 'admin') {
      store.deleteSessionsOf(user.id);
      store.promoteToAdmin(user.id);
      user = store.findUser(username)!;
    }
    const token = store.createLink(user.id, user.active ? 'reset' : 'activate');
    console.log(`${new URL(publicUrl).origin}/activeer#${token}`);
  } else {
    console.error('usage: cli.ts users | admin-link <username>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  store.close();
}
