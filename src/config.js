const fs = require('fs');
const path = require('path');

// Минимальный загрузчик .env — в продакшене нужны только BOT_TOKEN и ADMIN_ID.
// Всё остальное (БД, ссылки, меню TG, дефолтные курсы) создаётся автоматически.
function loadEnvFile() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile();

module.exports = {
  botToken: (process.env.BOT_TOKEN || '').trim(),
  adminId: (process.env.ADMIN_ID || '').trim(),
  port: parseInt(process.env.PORT || '8080', 10),
  publicUrl: ((process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')) || null,
};
