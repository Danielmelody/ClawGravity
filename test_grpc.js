const { execSync } = require('child_process');
const fs = require('fs');

const pbs = fs.readdirSync('C:/Users/Daniel/.gemini/antigravity/conversations').filter(f => f.endsWith('.pb'));
for (const f of pbs) {
    const text = fs.readFileSync('C:/Users/Daniel/.gemini/antigravity/conversations/' + f, 'utf8');
    const match = text.match(/file:\/\/\/[a-zA-Z0-9%_\-\/]+/g);
    if (match) {
        console.log(f, Array.from(new Set(match)));
        break;
    }
}
