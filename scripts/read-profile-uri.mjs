import fs from 'node:fs';

const logPath = 'C:/Users/xeon/AppData/Local/BraveSoftware/Brave-Browser/User Data/Profile 15/Local Extension Settings/bgiehfjphhflnlhkchakagmddnagdfhn/000003.log';
const buf = fs.readFileSync(logPath);
const text = buf.toString('utf8');
let idx = 0;
while ((idx = text.indexOf('olcrtc://', idx)) >= 0) {
  console.log('--- FOUND AT ' + idx + ' ---');
  console.log(text.slice(idx, idx + 150));
  idx += 10;
}

