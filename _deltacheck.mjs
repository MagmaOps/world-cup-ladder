const data = await (await fetch('http://localhost:8080/api/players')).json();
console.log('players:', data.players.length);
const withDelta = data.players.filter((p) => p.delta24h !== null && p.delta24h !== 0);
console.log('players with non-zero delta:', withDelta.length);
console.log('--- top 8 ---');
for (const p of data.players.slice(0, 8)) {
  console.log(`#${p.rank} ${p.name}: ${p.points} (delta24h=${p.delta24h})`);
}
// sanity: delta field present on every player
const allHave = data.players.every((p) => 'delta24h' in p);
console.log('every player has delta24h field:', allHave);
