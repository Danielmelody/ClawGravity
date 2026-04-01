import { CdpService } from './src/services/cdpService';

async function main() {
    console.log("Starting sniffer...");
    const cdp = new CdpService();
    await cdp.connect();
    console.log("Connected to CDP.");
    
    await cdp.call('Network.enable', {});
    
    console.log("Listening for StartCascade... Please do something in the UI to trigger it within 15 seconds.");
    
    cdp.on('Network.requestWillBeSent', (params: any) => {
        const url = params?.request?.url || '';
        if (url.includes('StartCascade')) {
            console.log("\n[SNIFF] StartCascade Request!");
            console.log("URL:", url);
            if (params.request.postData) {
                try {
                    console.log("Payload:", JSON.stringify(JSON.parse(params.request.postData), null, 2));
                } catch (e) {
                    console.log("Raw Payload:", params.request.postData);
                }
            }
        }
    });

    // Wait for 15 seconds
    await new Promise(r => setTimeout(r, 15000));
    console.log("Sniffer exiting.");
    await cdp.disconnect();
    process.exit(0);
}

main().catch(console.error);
