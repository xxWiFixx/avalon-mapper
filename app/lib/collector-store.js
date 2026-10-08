'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {transaction}=require('./collector-decode');
function create(file,{now=Date.now}={}) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const {DatabaseSync}=require('node:sqlite');
  const db=new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS mail_index(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS mail_pending(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS trades(scope TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS observations(hash TEXT PRIMARY KEY,realm TEXT NOT NULL,topic TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,hash TEXT NOT NULL,destination TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,UNIQUE(hash,destination));
    CREATE INDEX IF NOT EXISTS outbox_ready ON outbox(next_at,id);
    CREATE INDEX IF NOT EXISTS trades_recent ON trades(at DESC);
    CREATE TABLE IF NOT EXISTS counters(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
  `);
  const stmt=sql=>db.prepare(sql);
  const q={
    index:stmt('INSERT INTO mail_index VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data,at=excluded.at'),
    pending:stmt('INSERT INTO mail_pending VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data,at=excluded.at'),
    pairs:stmt('SELECT p.id,p.data AS body,i.data AS info,p.at FROM mail_pending p JOIN mail_index i ON p.scope=i.scope AND p.id=i.id WHERE p.scope=? LIMIT 4096'),
    trade:stmt('INSERT OR IGNORE INTO trades VALUES(?,?,?,?)'),
    dropPending:stmt('DELETE FROM mail_pending WHERE scope=? AND id=?'),
    observation:stmt('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)'),
    queue:stmt('INSERT OR IGNORE INTO outbox(hash,destination) VALUES(?,?)'),
    count:stmt('INSERT INTO counters VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=value+excluded.value'),
  };
  function atomic(fn){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}
  function mail(event) {
    const scope=JSON.stringify([event.scope.realm,event.scope.character]);
    return atomic(()=>{
      for(const info of event.infos||[])q.index.run(scope,info.mailId,JSON.stringify(info),event.at);
      if(event.body)q.pending.run(scope,event.mailId,JSON.stringify(event.body),event.at);
      let added=0;
      for(const pair of q.pairs.all(scope)){
        const row=transaction(JSON.parse(pair.body),JSON.parse(pair.info),pair.at);
        if(row)added+=Number(q.trade.run(scope,pair.id,JSON.stringify({...row,...event.scope}),event.at).changes);
        q.dropPending.run(scope,pair.id);
      }
      return added;
    });
  }
  function market(event,destinations=[]) {
    if(!['marketorders.ingest','markethistories.ingest'].includes(event.topic))throw new Error('invalid_topic');
    const data=JSON.stringify(event.body),at=now();
    // Keep distinct market snapshots while coalescing exact retransmits.
    const hash=crypto.createHash('sha256').update(event.realm+'\n'+event.topic+'\n'+data).digest('hex');
    return atomic(()=>{
      const added=q.observation.run(hash,event.realm,event.topic,data,at).changes;
      for(const destination of destinations){if(!['private','public'].includes(destination))throw new Error('invalid_destination');q.queue.run(hash,destination);}
      return Number(added);
    });
  }
  const next=destination=>stmt(`SELECT o.*,q.id,q.attempts FROM outbox q JOIN observations o ON o.hash=q.hash
    WHERE q.destination=? AND q.next_at<=? ORDER BY q.id LIMIT 1`).get(destination,now());
  function done(id){atomic(()=>{stmt('DELETE FROM outbox WHERE id=?').run(id);q.count.run('uploaded',1);});}
  function retry(id,attempts){stmt('UPDATE outbox SET attempts=attempts+1,next_at=? WHERE id=?').run(now()+Math.min(300000,5000*2**Math.min(6,attempts)),id);}
  function list({offset=0,limit=50}={}) {
    if(!Number.isInteger(offset)||offset<0||offset>1e7||!Number.isInteger(limit)||limit<1||limit>100)throw new Error('invalid_page');
    return stmt('SELECT data FROM trades ORDER BY at DESC,scope,id LIMIT ? OFFSET ?').all(limit,offset).map(r=>JSON.parse(r.data));
  }
  function summary(){return {mails:stmt('SELECT count(*) AS n FROM trades').get().n,
    observations:stmt('SELECT count(*) AS n FROM observations').get().n,queued:stmt('SELECT count(*) AS n FROM outbox').get().n,
    uploaded:stmt("SELECT value FROM counters WHERE key='uploaded'").get()?.value||0};}
  function clean(){const t=now();atomic(()=>{
    stmt('DELETE FROM mail_pending WHERE at<?').run(t-30*86400000);
    stmt('DELETE FROM mail_index WHERE at<?').run(t-30*86400000);
    stmt('DELETE FROM outbox WHERE hash IN (SELECT hash FROM observations WHERE at<?)').run(t-86400000);
    stmt('DELETE FROM observations WHERE at<? AND hash NOT IN (SELECT hash FROM outbox)').run(t-7*86400000);
  });}
  return {mail,market,next,done,retry,list,summary,clean,close(){db.close();}};
}
module.exports={create};
