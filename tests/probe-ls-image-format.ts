/**
 * Probe: use existing CdpService + GrpcCascadeClient to fetch a trajectory
 * that contains a user input with an image, to discover the image payload format.
 *
 * Also tries to directly test what happens when we send items with imageUri.
 *
 * Usage: npx tsx tests/probe-ls-image-format.ts
 */
import { CdpService } from '../src/services/cdpService';

async function main() {
    const cdp = new CdpService();
    
    // Try to discover and connect to an Antigravity workspace
    const workspacePaths = [
        'c:/Users/Daniel/Projects/antigravity-tunnel',
    ];
    
    let connected = false;
    for (const wp of workspacePaths) {
        try {
            await cdp.discoverAndConnectForWorkspace(wp);
            connected = true;
            console.log(`Connected to workspace: ${wp}`);
            break;
        } catch (e: any) {
            console.log(`Failed for ${wp}: ${e.message}`);
        }
    }
    
    if (!connected) {
        console.error('Could not connect to any Antigravity workspace');
        process.exit(1);
    }

    const client = await cdp.getGrpcClient();
    if (!client) {
        console.error('No gRPC client available');
        process.exit(1);
    }
    
    console.log('gRPC client ready');

    // 1. List cascades to find one with images
    const cascades = await client.listCascades();
    const cascadeIds = Object.keys(cascades || {});
    console.log(`Found ${cascadeIds.length} cascades`);
    
    // Search through cascades for any user input that has images
    for (const cid of cascadeIds.slice(0, 5)) {
        try {
            const traj = await client.rawRPC('GetCascadeTrajectory', { cascadeId: cid });
            const steps = traj?.trajectory?.steps || [];
            
            for (const step of steps) {
                if (step?.type !== 'CORTEX_STEP_TYPE_USER_INPUT') continue;
                
                // Check if this user input has any non-text items
                const items = step?.userInput?.items || [];
                const attachments = step?.userInput?.attachments || [];
                const images = step?.userInput?.images || [];
                const files = step?.userInput?.files || [];
                
                const hasNonTextItems = items.some((item: any) => {
                    const keys = Object.keys(item || {});
                    return keys.some(k => k !== 'text');
                });
                
                if (hasNonTextItems || attachments.length > 0 || images.length > 0 || files.length > 0) {
                    console.log('\n' + '='.repeat(60));
                    console.log('🖼️ FOUND USER INPUT WITH EXTRA DATA');
                    console.log('='.repeat(60));
                    console.log('Cascade:', cid.slice(0, 20) + '...');
                    console.log('userInput keys:', Object.keys(step.userInput || {}));
                    console.log('items:', JSON.stringify(items, null, 2).slice(0, 2000));
                    if (attachments.length) console.log('attachments:', JSON.stringify(attachments, null, 2).slice(0, 2000));
                    if (images.length) console.log('images:', JSON.stringify(images, null, 2).slice(0, 2000));
                    if (files.length) console.log('files:', JSON.stringify(files, null, 2).slice(0, 2000));
                    console.log('Full userInput:', JSON.stringify(step.userInput, null, 2).slice(0, 3000));
                    console.log('='.repeat(60));
                }
            }
        } catch (e: any) {
            // skip
        }
    }
    
    // 2. Now let's test: try sending different image payload formats 
    // to see what the LS API accepts. We'll test on a fresh cascade.
    console.log('\n--- Testing image payload formats ---');
    
    // First, check the raw LS API by just looking at the methods list
    try {
        const status = await client.getUserStatus();
        const configs = status?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
        const imageModels = configs.filter((c: any) => c.supportsImages);
        console.log(`Models supporting images: ${imageModels.map((c: any) => c.label || c.model).join(', ') || 'none found'}`);
    } catch (e: any) {
        console.log('getUserStatus failed:', e.message);
    }

    await cdp.disconnect();
    console.log('\nDone.');
}

main().catch(console.error);
