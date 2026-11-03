import { Bank } from './domain.js';
import { createApp } from './app.js';

const bank = new Bank();
const credentials = bank.seed();
const runtime = createApp(bank);
const server = runtime.app.listen(3000, '127.0.0.1', () => {
  console.log('Local mock banking prototype: http://127.0.0.1:3000');
  console.log('Synthetic demo credentials (regenerated on restart; do not use real passwords):');
  for (const credential of credentials)
    console.log(`${credential.username}: ${credential.password}`);
});
server.on('error', (error) => {
  console.error('Server startup failed:', error.message);
  runtime.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runtime.close();
    server.close();
  });
}
