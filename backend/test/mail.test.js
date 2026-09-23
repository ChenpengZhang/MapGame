import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir,readFile,stat,unlink } from 'node:fs/promises';
import { createMail } from '../src/infrastructure/mail.js';
test('development mail is stored privately, not sent or printed',async()=> {
  const directory = new URL('../.mail-preview/',import.meta.url);
  const before = new Set(await readdir(directory).catch(()=>[]));
  await createMail({MAIL_TRANSPORT:'preview'})({to:'test@example.com',otp:'123456',kind:'email-verification'});
  const names = (await readdir(directory)).filter(n=>!before.has(n));
  assert.equal(names.length,1);
  const file = new URL(names[0],directory);
  try {
    const message = JSON.parse(await readFile(file,'utf8'));
    assert.match(message.text,/123456/);
    assert.doesNotMatch(message.text,/https?:\/\//);
    assert.equal((await stat(file)).mode & 0o777,0o600);
  } finally { await unlink(file); }
});
