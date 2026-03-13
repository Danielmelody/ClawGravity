/**
 * Probe: Search Antigravity's bundled JS for image/upload handling.
 * Uses CDP Debugger.searchInContent on loaded scripts.
 *
 * Usage: npx tsx tests/probe-image-handling.ts
 */
import { CdpService } from '../src/services/cdpService';

async function main() {
    const cdp = new CdpService();
    await cdp.discoverAndConnectForWorkspace('c:/Users/Daniel/Projects/antigravity-tunnel');
    console.log('Connected');

    // Use Debugger.searchInContent to find image-related code
    // First, enable the debugger and get all script sources
    await (cdp as any).call('Debugger.enable', {});
    
    // Search for key terms in all loaded scripts

    const searchTerms = [
        'handleImageUpload',
        'handleFileDrop',
        'handleDrop',
        'imageUpload',
        'fileInput',
        'accept="image',
        'image/png',
        'readAsDataURL',
        'readAsArrayBuffer',
        'createObjectURL',
        'image.*context',
    ];

    // First let's find script IDs from the main bundle
    const scriptResult = await (cdp as any).call('Runtime.evaluate', {
        expression: `(() => {
            // Try to find the image upload mechanism   
            // Search for file input elements
            const fileInputs = document.querySelectorAll('input[type="file"]');
            const results = [];
            
            fileInputs.forEach(input => {
                results.push({
                    accept: input.getAttribute('accept'),
                    id: input.id,
                    name: input.name,
                    className: input.className,
                    parentHTML: input.parentElement?.outerHTML?.slice(0, 300),
                    listeners: Object.keys(input).filter(k => k.startsWith('__react')),
                });
            });
            
            // Also look for buttons that trigger image upload
            const uploadButtons = document.querySelectorAll('[aria-label*="image" i], [aria-label*="upload" i], [aria-label*="attach" i], [title*="image" i], [title*="upload" i], [title*="attach" i]');
            const buttons = [];
            uploadButtons.forEach(btn => {
                buttons.push({
                    tag: btn.tagName,
                    ariaLabel: btn.getAttribute('aria-label'),
                    title: btn.getAttribute('title'),
                    className: btn.className?.toString()?.slice(0, 100),
                    innerText: btn.textContent?.slice(0, 50),
                });
            });
            
            return { fileInputs: results, uploadButtons: buttons };
        })()`,
        returnByValue: true,
        awaitPromise: true,
    });
    
    console.log('File inputs and upload buttons in DOM:');
    console.log(JSON.stringify(scriptResult?.result?.value, null, 2));

    // Try a different approach - look at what happens when files change on the input
    // We need to find the React component that handles file input changes
    const reactProbe = await (cdp as any).call('Runtime.evaluate', {
        expression: `(() => {
            const inputs = document.querySelectorAll('input[type="file"]');
            const results = [];
            inputs.forEach(input => {
                // Try to find React fiber
                const reactKey = Object.keys(input).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
                if (reactKey) {
                    let fiber = input[reactKey];
                    // Walk up the fiber tree looking for image/upload handlers
                    let depth = 0;
                    while (fiber && depth < 20) {
                        const props = fiber.memoizedProps || fiber.pendingProps;
                        if (props) {
                            const propKeys = Object.keys(props);
                            const interestingKeys = propKeys.filter(k => 
                                k.includes('change') || k.includes('Change') || 
                                k.includes('upload') || k.includes('Upload') || 
                                k.includes('file') || k.includes('File') ||
                                k.includes('image') || k.includes('Image') ||
                                k.includes('drop') || k.includes('Drop') ||
                                k.includes('submit') || k.includes('Submit') ||
                                k.includes('send') || k.includes('Send'));
                            if (interestingKeys.length > 0) {
                                const handlers = {};
                                for (const k of interestingKeys) {
                                    handlers[k] = typeof props[k] === 'function' ? props[k].toString().slice(0, 300) : String(props[k]).slice(0, 100);
                                }
                                results.push({
                                    depth,
                                    componentType: fiber.type?.name || fiber.type?.displayName || typeof fiber.type,
                                    handlers,
                                });
                            }
                        }
                        fiber = fiber.return;
                        depth++;
                    }
                }
            });
            return results;
        })()`,
        returnByValue: true,
        awaitPromise: true,
    });

    console.log('\nReact component tree for file inputs:');
    console.log(JSON.stringify(reactProbe?.result?.value, null, 2));

    await (cdp as any).call('Debugger.disable', {});
    await cdp.disconnect();
    console.log('\nDone.');
}

main().catch(console.error);
