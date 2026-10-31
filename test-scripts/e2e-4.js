// e2e-4: imported profile carries real login state; spaces of the same
// profile share its cookie jar; other profiles are isolated.
//
// NOTE (environment): the sandbox egress proxy hangs any request carrying
// a Cookie header (verified directly with curl: plain/X-Custom -> 200,
// Cookie -> infinite hang). Cookie-bearing *network* navigation therefore
// cannot work inside this sandbox, independent of this port. This test
// verifies the storage semantics purely through CDP Storage, which is the
// layer the port owns.
const log = (label, value) => console.log(`${label}: ${value}`);
const names = (jar) =>
  JSON.stringify(
    (jar.cookies || []).map((c) => `${c.domain} ${c.name}=${c.value}`),
  );

const profList = await ego.listProfiles();
log("profiles", JSON.stringify(profList.profiles.map((p) => p.id)));
if (!profList.profiles.some((p) => p.id === "chrome-Default")) {
  throw new Error("chrome-Default not listed");
}

// Unknown profile id -> EGO_PROFILE_NOT_FOUND (spec error_code).
const bad = await ego.createTaskSpace("e2e9-bad", "no-such-profile");
log("unknown-profile", JSON.stringify(bad));
if (bad.error_code !== "EGO_PROFILE_NOT_FOUND") {
  throw new Error("expected EGO_PROFILE_NOT_FOUND");
}

// 1. Imported login state is visible with zero agent action.
const spaceX = await taskSpace("e2e9-x", { profileId: "chrome-Default" });
const jarX = await spaceX.page("p1").cdp("Storage.getCookies");
log("imported-cookie", names(jarX));
if (!jarX.cookies.some((c) => c.name === "importprobe" && c.value === "fromchrome")) {
  throw new Error("imported login cookie NOT visible in the space");
}

// 2. Same profile, second space: shares the jar (agent plants a cookie,
// first space sees it without any navigation).
const spaceX2 = await taskSpace("e2e9-x2", { profileId: "chrome-Default" });
await spaceX2.page("p1").cdp("Storage.setCookies", {
  cookies: [
    {
      name: "agentset",
      value: "xyz",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
      expires: Date.now() / 1000 + 3600,
    },
  ],
});
const jarXAgain = await spaceX.page("p1").cdp("Storage.getCookies");
const shared = jarXAgain.cookies.some(
  (c) => c.name === "agentset" && c.value === "xyz",
);
log("same-profile-shared-jar", String(shared));
if (!shared) throw new Error("cookie set in spaceX2 not visible in spaceX");

// 3. Default profile space: isolated, sees neither cookie.
const spaceD = await taskSpace("e2e9-d");
const jarD = await spaceD.page("p1").cdp("Storage.getCookies");
const leak = jarD.cookies.some(
  (c) => c.name === "importprobe" || c.name === "agentset",
);
log("default-isolated", String(!leak));
if (leak) throw new Error("profile cookie leaked into Default");

// Cleanup.
for (const s of [spaceX, spaceX2, spaceD]) {
  ego.useTaskSpace(s.spaceId);
  await s.finish({ keep: [] });
}
log("RESULT", "E2E-4 PASS");
