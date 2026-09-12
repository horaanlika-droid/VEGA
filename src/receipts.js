const fs = require('fs');
const path = require('path');
const store = require('./store');

// Чеки об оплате сохраняются на диск и отдаются операторам в Telegram как документы.
const DIR = path.join(store.DATA_DIR, 'receipts');

const MIME_EXT = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const MAX_SIZE = 8 * 1024 * 1024; // 8 МБ — с запасом под лимит Telegram на документы

// Принимает data URL (`data:<mime>;base64,...`), возвращает { name, path, mime, size }.
function saveReceipt(dataUrl, orderId) {
  const m = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('Некорректный файл чека — прикрепите PDF или фото.');
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error('Поддерживаются PDF, JPG, PNG и WebP.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('Файл чека пустой.');
  if (buf.length > MAX_SIZE) throw new Error('Чек слишком большой — максимум 8 МБ.');
  fs.mkdirSync(DIR, { recursive: true });
  const name = `order-${orderId}-${Date.now()}${ext}`;
  const filePath = path.join(DIR, name);
  fs.writeFileSync(filePath, buf);
  return { name, path: filePath, mime, size: buf.length };
}

module.exports = { saveReceipt, DIR, MAX_SIZE };
