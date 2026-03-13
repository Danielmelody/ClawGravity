/**
 * Probe: search Antigravity's bundled JS for SendUserCascadeMessage/items schema.
 * We evaluate JS in the renderer process to find the proto field definitions.
 *
 * Usage: npx tsx tests/probe-proto-schema.ts
 */
import { CdpService } from '../src/services/cdpService';

async function main() {
    const cdp = new CdpService();
    await cdp.discoverAndConnectForWorkspace('c:/Users/Daniel/Projects/antigravity-tunnel');
    console.log('Connected');

    // Search the renderer's JS source for image-related fields in cascade message proto
    const scripts = [
        // 1. Look for proto field names related to image in cascade messages
        `(() => {
            const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
            return scripts.filter(s => s.includes('workbench') || s.includes('cascade') || s.includes('vendor'));
        })()`,
        
        // 2. Search ALL string constants for imageUri or similar patterns
        `(() => {
            const found = [];
            // Check if there's a protobuf registry
            if (typeof globalThis.__proto_registry !== 'undefined') {
                found.push('proto_registry exists: ' + Object.keys(globalThis.__proto_registry).length);
            }
            
            // Search window for cascade-related objects
            for (const key of Object.keys(window)) {
                if (key.toLowerCase().includes('cascade') || key.toLowerCase().includes('proto')) {
                    found.push('window.' + key + ' = ' + typeof window[key]);
                }
            }
            return found;
        })()`,
        
        // 3. Try intercepting fetch to see what structure cascade UI sends
        // Actually let's try to find the actual source code pattern
        `(() => {
            // Search through all loaded JS resources for "imageUri" or similar
            const entries = performance.getEntries().filter(e => e.name.includes('.js'));
            return entries.map(e => e.name).filter(n => n.includes('workbench') || n.includes('vendor')).slice(0, 10);
        })()`,
    ];

    for (const script of scripts) {
        try {
            const result = await (cdp as any).call('Runtime.evaluate', {
                expression: script,
                returnByValue: true,
                awaitPromise: true,
            });
            console.log('Result:', JSON.stringify(result?.result?.value, null, 2));
        } catch (e: any) {
            console.log('Error:', e.message);
        }
    }

    // 4. The best approach: directly search the renderer's source bundle
    // Evaluate a script that uses fetch() to download the main JS bundle
    // and search it for image-related protobuf fields.
    console.log('\n--- Searching JS bundle for image proto fields ---');
    
    const searchScript = `(async () => {
        // Get all JS resources loaded
        const resources = performance.getEntries()
            .filter(e => e.name.endsWith('.js') && (e.name.includes('workbench') || e.name.includes('main')))
            .map(e => e.name);
        
        const imageTerms = ['imageUri', 'image_uri', 'imageData', 'image_data', 'imageBytes', 'image_bytes',
                           'imageContent', 'attachments', 'mimeType', 'mime_type', 'fileUri', 'file_uri',
                           'filePath', 'file_path', 'binaryData', 'binary_data', 'base64Data'];
        
        const found = {};
        
        for (const url of resources.slice(0, 3)) {
            try {
                const text = await (await fetch(url)).text();
                for (const term of imageTerms) {
                    const idx = text.indexOf(term);
                    if (idx !== -1) {
                        // Extract context around the match
                        const start = Math.max(0, idx - 100);
                        const end = Math.min(text.length, idx + 200);
                        const context = text.slice(start, end);
                        if (!found[term]) found[term] = [];
                        found[term].push({
                            url: url.split('/').pop(),
                            context: context.replace(/[\\n\\r]/g, ' ')
                        });
                    }
                }
            } catch (e) {
                // skip
            }
        }
        
        return found;
    })()`;

    try {
        const result = await (cdp as any).call('Runtime.evaluate', {
            expression: searchScript,
            returnByValue: true,
            awaitPromise: true,
            timeout: 30000,
        });
        const value = result?.result?.value;
        if (value && Object.keys(value).length > 0) {
            console.log('Found image-related terms in JS bundles:');
            for (const [term, matches] of Object.entries(value)) {
                console.log(`\n  📌 ${term}:`);
                for (const m of matches as any[]) {
                    console.log(`    Source: ${m.url}`);
                    console.log(`    Context: ...${m.context.slice(0, 300)}...`);
                }
            }
        } else {
            console.log('No image-related proto terms found in main JS bundles');
        }
    } catch (e: any) {
        console.log('Error searching bundles:', e.message);
    }

    // 5. The most direct approach: search near "SendUserCascadeMessage" in the JS
    console.log('\n--- Searching near SendUserCascadeMessage ---');
    const nearSearchScript = `(async () => {
        const resources = performance.getEntries()
            .filter(e => e.name.endsWith('.js'))
            .map(e => e.name);
        
        for (const url of resources) {
            try {
                const text = await (await fetch(url)).text();
                const idx = text.indexOf('SendUserCascadeMessage');
                if (idx !== -1) {
                    const contexts = [];
                    let searchStart = 0;
                    let found;
                    while ((found = text.indexOf('SendUserCascadeMessage', searchStart)) !== -1) {
                        const start = Math.max(0, found - 200);
                        const end = Math.min(text.length, found + 500);
                        contexts.push(text.slice(start, end).replace(/[\\n\\r]/g, ' '));
                        searchStart = found + 1;
                        if (contexts.length >= 5) break;
                    }
                    return {
                        file: url.split('/').pop(),
                        contexts
                    };
                }
            } catch (e) { continue; }
        }
        return null;
    })()`;
    
    try {
        const result = await (cdp as any).call('Runtime.evaluate', {
            expression: nearSearchScript,
            returnByValue: true,
            awaitPromise: true,
            timeout: 30000,
        });
        const value = result?.result?.value;
        if (value) {
            console.log(`Found in: ${value.file}`);
            for (let i = 0; i < value.contexts.length; i++) {
                console.log(`\nContext ${i + 1}:`);
                console.log(value.contexts[i].slice(0, 800));
            }
        } else {
            console.log('SendUserCascadeMessage not found in any JS bundle');
        }
    } catch (e: any) {
        console.log('Error:', e.message);
    }

    await cdp.disconnect();
    console.log('\nDone.');
}

main().catch(console.error);
