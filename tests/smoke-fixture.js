const task = await taskSpace('fixture')
const page = task.page('p1')
await page.goto('http://127.0.0.1:8899/fixture.html')
console.log(await page.snapshot({ scope: 'full_page' }))
