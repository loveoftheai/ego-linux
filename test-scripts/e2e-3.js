// 完整任务: 打开网页 -> snapshot -> click -> fill -> 回读结果
const t = await taskSpace("e2e-final");
const p = t.page("p1");
await p.goto("file:///home/hatch/workspace/ego-re/linux/test-fixtures/form.html", { waitUntil: "load", timeout: 20000 });
console.log("URL:", await p.url());

const content = await p.snapshot();
console.log("=== SNAPSHOT ===");
console.log(content);

// fill email + password using refs from a fresh snapshot
await p.fill("@1", "justin@example.com");
await p.fill("@2", "s3cr3t");
const clickReceipt = await p.click("@3");
console.log("click receipt keys:", Object.keys(clickReceipt || {}));

// 回读: 表单提交后 #result 显示 "signed in as justin@example.com"
const resultText = await p.evaluate(() => document.getElementById("result").textContent);
console.log("RESULT TEXT:", JSON.stringify(resultText));
const emailValue = await p.evaluate(() => document.getElementById("email").value);
console.log("EMAIL VALUE:", JSON.stringify(emailValue));
if (resultText === "signed in as justin@example.com" && emailValue === "justin@example.com") {
  console.log("E2E PASS");
} else {
  console.log("E2E FAIL");
  process.exitCode = 1;
}
