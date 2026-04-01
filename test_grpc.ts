import { CdpService } from './src/services/cdpService';
import { ConsoleLogger } from './src/utils/logger.ts';
const s = new CdpService('file:///c:/Users/Daniel/Projects/ClawGravity', new ConsoleLogger());
s.getOrConnect().then(async cdp => {
    const client = await s.getLSClient();
    const resp = await client.rawRPC('GetAllCascadeTrajectories', {});
    console.log(JSON.stringify(resp, null, 2));
    process.exit(0);
});
