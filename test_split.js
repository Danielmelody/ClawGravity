const { splitTelegramText } = require('./dist/platform/telegram/telegramDeliveryPipeline.js');
let str = '<b>';
for (let i = 0; i < 4096; i++) str += 'a';
str += '</b>';
console.log(splitTelegramText(str).map(x => x.length));
