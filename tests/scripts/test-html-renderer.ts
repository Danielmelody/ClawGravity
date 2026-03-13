import { htmlToTelegramHtml } from '../../src/platform/telegram/htmlToTelegramHtml';

const sampleIdeHtml = `
<div class="step planner-response">
  <div class="Header">
    <span class="Icon">🤔</span><span class="Title">Thinking</span>
  </div>
  <div class="Content">
    <p>I need to search for the files.</p>
  </div>
</div>
<div class="step tool-call">
  <div class="Header">
    <span class="Icon">🔧</span><span class="Title">find_by_name</span>
  </div>
  <div class="Content">
    <code>{"pattern": "*.ts"}</code>
  </div>
</div>
`;

console.log("=== RAW HTML ===");
console.log(sampleIdeHtml);
console.log("\n=== TELEGRAM HTML ===");
console.log(htmlToTelegramHtml(sampleIdeHtml));
