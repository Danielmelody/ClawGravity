const http = require('http');

const req = http.request({
  host: '127.0.0.1',
  port: 9000,
  path: '/api/cascade/6478f6b9-3786-42b1-8e93-b61f64340f00/trajectory',
  method: 'GET'
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const steps = parsed.trajectory?.steps || parsed.steps || [];
      console.log(`Fetched ${steps.length} steps`);
      const len = steps.length;
      if (len > 0) {
        console.log("Last 2 steps:", JSON.stringify(steps.slice(len - 2), null, 2));
      }
    } catch (e) {
      console.log('Error parsing', e);
    }
  });
});
req.on('error', console.error);
req.end();
