import { CdpService } from '../src/services/cdpService';
import { ChatSessionService } from '../src/services/chatSessionService';
import { LsClientManager } from '../src/services/lsClientManager';

async function main() {
    const lsManager = new LsClientManager();
    const cdp = new CdpService({ lsClientManager: lsManager });
    await cdp.discoverAndConnectForWorkspace("c:\Users\Daniel\Projects\ClawGravity");
    const chatService = new ChatSessionService();
    const sessions = await chatService.listAllSessions(cdp);
    console.log("Sessions found:", sessions.length);
    console.log("Top 3:", sessions.slice(0, 3));
    process.exit(0);
}
main().catch(console.error);
