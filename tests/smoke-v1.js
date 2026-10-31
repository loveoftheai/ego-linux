await useOrCreateTaskSpace('smoke')
await gotoAndWait('https://example.com')
console.log(await snapshotText())
