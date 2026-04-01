const fs = require('fs');
const buffer = fs.readFileSync('C:/Users/Daniel/.gemini/antigravity/conversations/9bded326-5843-4338-80f4-333aaecd49a0.pb');
const STR_LEN_CUTOFF = 30; // Min chars to care about
let strings = [];
let currentStr = "";

for (let i = 0; i < buffer.length; i++) {
    const charCode = buffer[i];
    if (charCode >= 32 && charCode <= 126 || charCode === 10) { // printable ascii + newline
        currentStr += String.fromCharCode(charCode);
    } else {
        if (currentStr.length >= STR_LEN_CUTOFF) {
            strings.push(currentStr.trim());
        }
        currentStr = "";
    }
}
if (currentStr.length >= STR_LEN_CUTOFF) strings.push(currentStr.trim());

fs.writeFileSync('C:/Users/Daniel/Projects/ClawGravity/extracted_session.txt', strings.join('\n\n=====\n\n'));
