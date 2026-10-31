// 完整任务回归: 打开网页 -> snapshot -> fill -> click -> 回读结果 (动态 ref)
const t = await taskSpace("e2e-final-r3");
const p = t.page("p1");
await p.goto("file:///home/hatch/workspace/ego-re/linux/test-fixtures/form.html", {
  waitUntil: "load",
  timeout: 20000,
});
console.log("URL:", await p.url());
const content = await p.snapshot();
const refs = [...content.matchAll(/\[ref=(\d+)/g)].map((m) => `@${m[1]}`);
console.log("refs:", refs.join(", "));
if (refs.length < 3) throw new Error("expected >= 3 refs");
// fixture order: textfield Email, textfield Password, button Sign in
await p.fill(refs[0], "justin@example.com");
await p.fill(refs[1], "s3cr3t");
const receipt = await p.click(refs[2]);
console.log("click receipt keys:", Object.keys(receipt || {}));
const resultText = await p.evaluate(() => document.getElementById("result").textContent);
console.log("RESULT TEXT:", JSON.stringify(resultText));
const emailValue = await p.evaluate(() => document.getElementById("email").value);
console.log("EMAIL VALUE:", JSON.stringify(emailValue));
if (resultText === "signed in as justin@example.com" && emailValue === "justin@example.com") {
  console.log("E2E-3R PASS");
} else {
  console.log("E2E-3R FAIL");
  process.exitCode = 1;
}
await t.finish({ keep: [] });
