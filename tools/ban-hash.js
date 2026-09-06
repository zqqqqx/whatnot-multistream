// Bildet den Abdruck eines Usernamens fuer banned-users.json.
//   node tools/ban-hash.js voltico
// Ausgegeben wird nur der Abdruck - der Name selbst gehoert nicht in die Datei.
const { hash, normalize } = require('../bans.js');

const names = process.argv.slice(2);
if (!names.length) {
  console.log('Aufruf: node tools/ban-hash.js <username> [<username> ...]');
  process.exit(1);
}
for (const name of names) {
  if (!normalize(name)) { console.error('leer uebersprungen'); continue; }
  console.log('  "' + hash(name) + '",');
}
