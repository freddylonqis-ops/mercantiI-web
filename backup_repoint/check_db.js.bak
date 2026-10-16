const https = require('https');
https.get('https://device-streaming-2f9e68b6-default-rtdb.firebaseio.com/.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const db = JSON.parse(data);
      if(!db) { console.log('Empty DB'); return; }
      const keys = Object.keys(db);
      console.log('Root keys:', keys);
      for(const k of keys) {
        const count = Object.keys(db[k] || {}).length;
        console.log(`Path '/${k}' has ${count} entries.`);
      }
    } catch(e) {
      console.error('Error parsing JSON:', e.message);
    }
  });
}).on('error', err => console.error(err));