
const target = 'c:\Users\Daniel\Projects\ClawGravity'.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
const uri = 'file:///c%3A/Users/Daniel/Projects/ClawGravity';
let p = uri.replace(/^file:\/\//i, '');
p = decodeURIComponent(p);
if (p.match(/^\/[a-zA-Z]:/)) p = p.substring(1);
const local = p.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
console.log('target:', target);
console.log('p:', p);
console.log('local:', local);
console.log('match:', local === target);

