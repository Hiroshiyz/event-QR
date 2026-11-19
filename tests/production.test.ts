import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { makePool, migrate } from '../src/server/db.js';
import { passwordHash } from '../src/server/crypto.js';
test('正式build啟動、靜態資源、API前綴與Secure Session Cookie',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
  const pool=makePool(url), event=randomUUID(), user=randomUUID(), password=randomBytes(24).toString('base64url');
  await migrate(pool);
  await pool.query('INSERT INTO events(id,name) VALUES ($1,$2)',[event,'正式build測試']);
  await pool.query("INSERT INTO staff_users(id,email,password_hash,role) VALUES ($1,$2,$3,'EVENT_STAFF')",[user,user+'@test.invalid',passwordHash(password)]);
  const child=spawn(process.execPath,['dist/server/src/server/index.js'],{env:{...process.env,DATABASE_URL:url,EVENT_ID:event,PRINT_ENCRYPTION_KEY:randomBytes(32).toString('hex'),APP_ORIGIN:'https://event.example.test',NODE_ENV:'production',PORT:'3001'},stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  try {
    let ready=false;
    for(let i=0;i<50;i++) {
      if(child.exitCode!==null) throw new Error('Production server exited: '+stderr);
      try {ready=(await fetch('http://127.0.0.1:3001/health')).ok;}catch{ /* startup */ }
      if(ready)break; await setTimeout(100);
    }
    assert.ok(ready,'Production server did not start');
    const root=await fetch('http://127.0.0.1:3001/'), html=await root.text();
    assert.equal(root.status,200); assert.match(root.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    const asset=html.match(/src="(\/assets\/[^"]+)"/)?.[1]; assert.ok(asset);
    assert.equal((await fetch('http://127.0.0.1:3001'+asset)).status,200);
    assert.equal((await fetch('http://127.0.0.1:3001/api/auth/me')).status,401);
    const login=await fetch('http://127.0.0.1:3001/api/auth/login',{method:'POST',headers:{Origin:'https://event.example.test','Content-Type':'application/json'},body:JSON.stringify({email:user+'@test.invalid',password})});
    assert.equal(login.status,200); assert.match(login.headers.get('set-cookie')!,/Secure/); assert.match(login.headers.get('set-cookie')!,/HttpOnly/);
  } finally {
    if(child.exitCode===null) {child.kill('SIGTERM');await once(child,'exit');}
    await pool.end();
  }
});
