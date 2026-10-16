const https = require('https');
https.get('https://device-streaming-2f9e68b6-default-rtdb.firebaseio.com/mercaolinebenficios_z13_web_core_windows_net.json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const db = JSON.parse(data);
      const keys = Object.keys(db);
      console.log('Total entries:', keys.length);
      // Sample 3 entries
      for(let i=0; i<3; i++) {
        console.log(keys[i], db[keys[i]]);
      }
    } catch(e) {
      console.error('Error parsing JSON:', e.message);
    }
  });
}).on('error', err => console.error(err));