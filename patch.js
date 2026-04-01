const fs = require('fs');
const path = 'src/services/grpcResponseMonitor.ts';
let code = fs.readFileSync(path, 'utf8');

if (!code.includes('private anchorLossLogged = false;')) throw new Error("Could not find anchorLossLogged");
code = code.replace(
    'private anchorLossLogged = false;',
    "private anchorLossLogged = false;\n    private lastSeenBlocks: string[] = [];\n    private emittedTextPrefix = '';"
);

// We need to inject 'let currentAssistantBlocks: string[] = [];'
code = code.replace(
    'let latestResponseText: string | null = null;',
    "let latestResponseText: string | null = null;\n            let currentAssistantBlocks: string[] = [];"
);

code = code.replace(
    "latestResponseText = null;\n                    latestAssistantHasToolCalls = false;",
    "latestResponseText = null;\n                    currentAssistantBlocks = [];\n                    this.lastSeenBlocks = [];\n                    this.emittedTextPrefix = '';\n                    latestAssistantHasToolCalls = false;"
);

code = code.replace(
    `                    const stepText = extractAssistantStepText(step);
                    if (stepText) {
                        latestResponseText = latestResponseText
                            ? latestResponseText + '\n\n' + stepText
                            : stepText;
                    }`,
    `                    const stepText = extractAssistantStepText(step);
                    if (stepText) {
                        currentAssistantBlocks.push(stepText);
                    }`
);

// Now the alignment logic. We place it right after the loop.
const afterLoopOld = `
            return {
                steps,`;

const alignLogic = `
            if (this.lastSeenBlocks.length > 0 && currentAssistantBlocks.length > 0) {
                const firstNew = currentAssistantBlocks[0];
                let matchIdx = -1;
                for (let i = 0; i < this.lastSeenBlocks.length; i++) {
                    const oldB = this.lastSeenBlocks[i];
                    if (oldB === firstNew || firstNew.startsWith(oldB) || oldB.startsWith(firstNew)) {
                        matchIdx = i;
                        break;
                    }
                }
                if (matchIdx > 0) {
                    const dropped = this.lastSeenBlocks.slice(0, matchIdx);
                    this.emittedTextPrefix += dropped.join('\n\n') + '\n\n';
                } else if (matchIdx === -1 && anchorRecovered) {
                    this.emittedTextPrefix += this.lastSeenBlocks.join('\n\n') + '\n\n';
                }
            } else if (this.lastSeenBlocks.length > 0 && currentAssistantBlocks.length === 0 && anchorRecovered) {
                this.emittedTextPrefix += this.lastSeenBlocks.join('\n\n') + '\n\n';
            }
            if (currentAssistantBlocks.length > 0) {
                this.lastSeenBlocks = currentAssistantBlocks;
            }

            latestResponseText = currentAssistantBlocks.length > 0
                ? this.emittedTextPrefix + currentAssistantBlocks.join('\n\n')
                : (this.emittedTextPrefix.length > 0 ? this.emittedTextPrefix.trim() : null);

            return {
                steps,`;

code = code.replace(afterLoopOld, alignLogic);

fs.writeFileSync(path, code);
console.log("Patched successfully!");
