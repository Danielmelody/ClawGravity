const fs = require('fs');
const content = fs.readFileSync('C:/Users/Daniel/.gemini/antigravity/conversations/9bded326-5843-4338-80f4-333aaecd49a0.pb', 'utf8');
const isClaw = content.includes('ClawGravity');
const isDeep = content.includes('DeepMarket');
console.log('ClawGravity mentioned:', isClaw);
console.log('DeepMarket mentioned:', isDeep);
