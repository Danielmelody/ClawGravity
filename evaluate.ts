import { CdpService } from './src/services/cdpService';
(async () => {
  const cdp = new CdpService();
  await cdp.connect();
  const script = "typeof window.onstorage";
  const res = await cdp.evaluateRuntime(script);
  console.log(res);
  process.exit(0);
})();
