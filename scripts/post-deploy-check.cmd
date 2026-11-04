@echo off
rem Runs after a deploy: opens the live database through the new core, which also applies
rem any pending schema migration, and writes the result where the morning check can read it.
cd /d D:\git-workspace\repos\soulbridge
node packages\cli\src\cli.ts stats > "%USERPROFILE%\.soulbridge\post-deploy-check.txt" 2>&1
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.soulbridge/soul.db',{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT status, COUNT(*) n FROM facts GROUP BY status').all()));console.log(JSON.stringify(db.prepare('SELECT role, COUNT(*) n FROM facts GROUP BY role').all()));console.log(JSON.stringify(db.prepare('SELECT status, COUNT(*) n FROM gaps GROUP BY status').all()));console.log(JSON.stringify(db.prepare('SELECT close_reason, COUNT(*) n FROM gaps GROUP BY close_reason').all()));console.log('facts_with_valid_until=' + db.prepare('SELECT COUNT(*) n FROM facts WHERE valid_until IS NOT NULL').get().n);console.log('facts_open=' + db.prepare(\"SELECT COUNT(*) n FROM facts WHERE valid_until IS NULL AND status = 'active'\").get().n);" >> "%USERPROFILE%\.soulbridge\post-deploy-check.txt" 2>&1
