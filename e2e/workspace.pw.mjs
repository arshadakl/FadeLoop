import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const password = "mobile test password with spaces";
const media = {
  media: [
    {
      id: "media1",
      media_type: "IMAGE",
      caption: "Creator guide",
      media_url:
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="300" height="300"%3E%3Crect width="300" height="300" fill="%232563eb"/%3E%3C/svg%3E',
    },
  ],
};

async function signIn(page) {
  await page.route("**/api/media", (route) => route.fulfill({ json: media }));
  await page.goto("/");
  await page.getByLabel("Email address").fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New automation", exact: true }),
  ).toBeVisible();
}
async function navigate(page, name) {
  await page
    .getByRole("button", { name, exact: true })
    .filter({ visible: true })
    .first()
    .click();
}
async function choose(page, label, option) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function noOverflow(page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

for (const theme of ["light", "dark"]) {
  for (const width of [320, 375, 390, 768, 1440]) {
    test(`${theme} theme at ${width}px: login, lists, builder, dashboard, contacts and legal pages`, async ({
      page,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 850 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/${theme}-${width}-login.png`,
        fullPage: true,
      });
      await signIn(page);
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/${theme}-${width}-automations.png`,
        fullPage: true,
      });
      await expect(page.getByRole("group")).toBeVisible();
      await page.getByLabel("Search automations").fill("no result");
      await expect(
        page.getByText("No automations match your search."),
      ).toBeVisible();
      await page.getByLabel("Search automations").fill("");
      await page.getByRole("group").first().click();
      await expect(page.getByRole("button", { name: /^Save/ })).toBeVisible();
      await noOverflow(page);
      if (width < 768)
        await expect(
          page.getByRole("button", { name: "Live preview" }),
        ).toHaveAttribute("aria-expanded", "false");
      if (
        (await page
          .getByRole("button", { name: "Live preview" })
          .getAttribute("aria-expanded")) === "false"
      )
        await page.getByRole("button", { name: "Live preview" }).click();
      await page.evaluate(() => scrollTo(0, 0));
      await noOverflow(page);
      await page.screenshot({
        path: `test-results/${theme}-${width}-builder.png`,
        fullPage: true,
      });
      // Return without editing the draft; unsaved-change behavior is tested separately.
      await navigate(page, "Dashboard");
      await expect(
        page.getByRole("region", { name: "Dashboard metrics" }),
      ).toBeVisible();
      await noOverflow(page);
      await choose(page, "Dashboard date range", "Last 7 days");
      await expect(
        page.getByRole("region", { name: "Dashboard metrics" }),
      ).toBeVisible();
      await page.screenshot({
        path: `test-results/${theme}-${width}-dashboard.png`,
        fullPage: true,
      });
      await navigate(page, "Contacts");
      await expect(
        page.getByText("creator@example.com", { exact: true }),
      ).toBeVisible();
      await noOverflow(page);
      await expect(
        page.getByText("creator@example.com", { exact: true }),
      ).toBeVisible();
      const downloaded = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export CSV" }).click();
      expect((await downloaded).suggestedFilename()).toBe(
        "fadeloop-contacts.csv",
      );
      await navigate(page, width < 768 ? "More" : "Account & appearance");
      await choose(page, "Appearance", theme === "light" ? "Dark" : "Light");
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme === "light" ? "dark" : "light",
      );
      await page.getByRole("button", { name: "Close menu" }).click();
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        theme === "light" ? "dark" : "light",
      );
      for (const path of ["/privacy", "/terms", "/data-deletion"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await noOverflow(page);
      }
      expect(errors).toEqual([]);
      await page.screenshot({
        path: `test-results/${theme}-${width}-legal.png`,
        fullPage: true,
      });
    });
  }
}

test("dashboard ignores obsolete filter responses", async ({ page }) => {
  let release;
  let sevenStarted;
  const delayed = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { sevenStarted = resolve; });
  await page.route("**/api/dashboard?*", async (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get("days"));
    if (days === 3650) return route.continue();
    if (days === 7) { sevenStarted(); await delayed; }
    const data = { cards: {comments: days, sends: 0, clicks: 0, ctr: 0, follows: 0, emails: 0, delivered: 0}, funnel: [{label: "Commented", value: days, pct: 100}] };
    try { await route.fulfill({json: data}); } catch { /* The obsolete request was aborted. */ }
  });
  await signIn(page); await navigate(page, "Dashboard");
  await expect(page.getByRole("region", {name: "Dashboard metrics"})).toBeVisible();
  await choose(page, "Dashboard date range", "Last 7 days"); await started;
  await choose(page, "Dashboard date range", "Last 90 days");
  const comments = page.getByRole("region", {name: "Dashboard metrics"}).getByRole("article").filter({hasText: "Comments"});
  await expect(comments.getByText("90", {exact: true})).toBeVisible(); release();
  await expect(page.getByRole("combobox", {name: "Dashboard date range"})).toContainText("Last 90 days");
  await expect(comments.getByText("90", {exact: true})).toBeVisible();
});

test("legacy disabled public replies without texts remain editable", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/campaigns", route => route.fulfill({json: {campaigns: [{campaign_id: "legacy", name: "Legacy automation", media_id: "media1", keywords: ["LINK"], public_reply: {enabled: false}, reward: {type: "link", value: "https://example.com"}, copy: {opening: "Hello", delivery: "{reward}"}, active: false, updated_at: 0}]}}));
  await signIn(page); await page.getByRole("group", {name: "Legacy automation"}).click();
  await page.getByRole("switch", {name: "Enable public reply"}).click();
  await expect(page.getByLabel("Public replies (one per line, rotated)")).toHaveValue("");
  const preview = page.getByRole("button", {name: "Live preview"});
  if (await preview.getAttribute("aria-expanded") === "false") await preview.click();
  await page.getByRole("tab", {name: "Comments", exact: true}).click();
  await expect(page.getByRole("tabpanel")).toBeVisible(); expect(errors).toEqual([]);
});

test("login errors, visibility, logout and session expiration", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("owner@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("incorrect long password");
  await page.getByRole("button", { name: "Show password" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "text",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid email or password",
  );
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.getByLabel("Email address")).toHaveValue(
    "owner@example.com",
  );
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New automation", exact: true }),
  ).toBeVisible();
  await navigate(page, "Account & appearance");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await signIn(page);
  await navigate(page, "Contacts");
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByRole("form", { name: "Sign in" })).toBeVisible();
});

test("mobile campaign save, activation, archive, restore, delete and draft protection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await signIn(page);
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  await page.getByLabel("Automation name").fill("Mobile test automation");
  await page.getByRole("button", { name: "Select post Creator guide" }).click();
  await page.getByLabel("Keywords (comma separated)").fill("MOBILE");
  await page.getByLabel("Link or reward").fill("https://example.com/mobile");
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toContainText("Saved");
  await page.getByRole("button", { name: "Go live", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New automation", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("group", { name: "Mobile test automation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Keywords (comma separated)").fill("UNSAVED");
  page.once("dialog", (dialog) => dialog.dismiss());
  await navigate(page, "Contacts");
  await expect(page.getByLabel("Keywords (comma separated)")).toHaveValue(
    "UNSAVED",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await navigate(page, "Automations");
  await page.getByLabel("Search automations").fill("Mobile test automation");
  await page
    .getByRole("checkbox", { name: "Select Mobile test automation" })
    .check();
  await page.getByRole("button", { name: "Archive selected" }).click();
  await expect(page.getByRole("group")).toHaveCount(0);
  await navigate(page, "More");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Archive", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "Mobile test automation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(
    page.getByRole("article", { name: "Mobile test automation" }),
  ).toHaveCount(0);
  await navigate(page, "Automations");
  await page
    .getByRole("checkbox", { name: "Select Mobile test automation" })
    .check();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete selected" }).click();
  await expect(page.getByRole("group")).toHaveCount(0);
});

test("Instagram connect uses a protected state and no URL token", async ({
  page,
}) => {
  let handoff;
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { connected: false } }),
  );
  await page.route("**/auth/authorize", async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(302);
    handoff = new URL(response.headers().location);
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>Instagram authorization handoff</h1>",
    });
  });
  await page.goto("/");
  await page.getByLabel("Email address").fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Connect Instagram" }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("link", { name: "Connect Instagram" })
      .getAttribute("href"),
  ).toBe("/auth/authorize");
  await page.getByRole("link", { name: "Connect Instagram" }).click();
  await expect(
    page.getByRole("heading", { name: "Instagram authorization handoff" }),
  ).toBeVisible();
  expect(handoff.origin).toBe("https://www.instagram.com");
  expect(handoff.pathname).toBe("/oauth/authorize");
  expect(handoff.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
  expect(handoff.searchParams.has("token")).toBe(false);
});

test("campaign loading and error states recover without losing the workspace", async ({
  page,
}) => {
  let attempts = 0;
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/campaigns", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    attempts++;
    if (attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Campaigns are temporarily unavailable." },
      });
    if (attempts === 2) await delayed;
    return route.fulfill({ response: await route.fetch() });
  });
  await signIn(page);
  await expect(page.getByRole("alert")).toContainText(
    "temporarily unavailable",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Loading your workspace",
  );
  release();
  await expect(
    page.getByRole("group", { name: /Creator guide/ }),
  ).toBeVisible();
  await navigate(page, "Dashboard");
  await expect(
    page.getByRole("region", { name: "Dashboard metrics" }),
  ).toBeVisible();
});

test("empty automations and zero-data dashboard retain the screenshot layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/campaigns", (route) =>
    route.fulfill({ json: { campaigns: [] } }),
  );
  await page.route("**/api/dashboard?*", (route) =>
    route.fulfill({
      json: {
        cards: {
          comments: 0,
          sends: 0,
          clicks: 0,
          ctr: 0,
          follows: 0,
          emails: 0,
          delivered: 0,
        },
        funnel: [
          { label: "Commented", value: 0, pct: 100 },
          ...["Clicked", "Followed", "Gave email", "Delivered"].map(
            (label) => ({ label, value: 0, pct: 0 }),
          ),
        ],
      },
    }),
  );
  await signIn(page);
  await expect(page.getByText(/No automations yet/)).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "test-results/reference-empty-automations.png",
    fullPage: true,
  });
  await navigate(page, "Dashboard");
  await expect(
    page.getByRole("region", { name: "Dashboard metrics" }),
  ).toBeVisible();
  await expect(page.getByText("100%", { exact: true })).toBeVisible();
  await noOverflow(page);
  await page.screenshot({
    path: "test-results/reference-empty-dashboard.png",
    fullPage: true,
  });
});

test("builder switches, comma entry, public replies and all preview modes preserve payloads", async ({
  page,
}) => {
  let payload;
  await page.route("**/api/campaigns", async (route) => {
    if (route.request().method() === "POST") {
      payload = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    }
    return route.continue();
  });
  await signIn(page);
  await page
    .getByRole("button", { name: "New automation", exact: true })
    .click();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("alert")).toContainText("Select a post");
  await page.getByRole("button", { name: "Select post Creator guide" }).click();
  await page.getByLabel("Keywords (comma separated)").fill("GUIDE, LINK");
  await page.getByLabel("Exclude words (optional)").fill("fake, scam");
  await page.getByRole("switch", { name: "Enable public reply" }).click();
  await page
    .getByLabel("Public replies (one per line, rotated)")
    .fill("First reply\nSecond reply");
  await page.getByRole("switch", { name: "Ask users to follow" }).click();
  await page
    .getByRole("switch", { name: "Ask for email", exact: true })
    .click();
  await page.getByLabel("Follow message").fill("Please follow us");
  await page.getByLabel("Email ask message").fill("Share your email");
  await page.getByLabel("Link or reward").fill("https://example.com/resource");
  const preview = page.getByRole("button", { name: "Live preview" });
  if ((await preview.getAttribute("aria-expanded")) === "false")
    await preview.click();
  await expect(page.getByRole("tabpanel")).toContainText("Please follow us");
  await expect(page.getByRole("tabpanel")).toContainText("Share your email");
  await page.getByRole("tab", { name: "Comments", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("First reply");
  await page.getByRole("tab", { name: "Post", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("Creator guide");
  await page.getByRole("tab", { name: "DM", exact: true }).click();
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /^Saved$/ }),
  ).toBeVisible();
  expect(payload.campaign.keywords).toEqual(["GUIDE", "LINK"]);
  expect(payload.campaign.exclude).toEqual(["fake", "scam"]);
  expect(payload.campaign.public_reply).toEqual({
    enabled: true,
    texts: ["First reply", "Second reply"],
  });
  expect(payload.campaign.check_follow).toBe(true);
  expect(payload.campaign.ask_email).toBe(true);
  expect(payload.active).toBe(false);
  expect(payload.campaign.copy.follow_gate).toBe("Please follow us");
  expect(payload.campaign.copy.email_ask).toBe("Share your email");
  expect(payload.campaign).not.toHaveProperty("opening_enabled");
});

test("login distinguishes minimum length, throttling and network errors", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("owner@example.com");
  await page.getByLabel("Password", { exact: true }).fill("seven77");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("8–128 characters");
  await page.route("**/session/login", (route) =>
    route.fulfill({
      status: 429,
      headers: { "retry-after": "121" },
      json: { error: "Too many attempts" },
    }),
  );
  await page.getByLabel("Password", { exact: true }).fill("eight123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Try again in 3 minutes");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await page.unroute("**/session/login");
  await page.route("**/session/login", (route) => route.abort("failed"));
  await page.getByLabel("Password", { exact: true }).fill("eight123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Check your connection");
});

for (const theme of ["light", "dark"])
  for (const width of [390, 1440]) {
    test(`${theme} ${width}px accessibility and keyboard account controls`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const audit = async () => {
        await page.evaluate(() => document.fonts.ready);
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        expect(
          result.violations.map((v) => ({
            id: v.id,
            nodes: v.nodes.map((n) => ({
              target: n.target,
              summary: n.failureSummary,
            })),
          })),
        ).toEqual([]);
      };
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Welcome back" }),
      ).toBeVisible();
      await audit();
      await signIn(page);
      await expect(page.getByRole("group")).toBeVisible();
      await audit();
      await navigate(page, "Dashboard");
      await expect(
        page.getByRole("region", { name: "Dashboard metrics" }),
      ).toBeVisible();
      await audit();
      await navigate(page, "Contacts");
      await expect(
        page.getByText("creator@example.com", { exact: true }),
      ).toBeVisible();
      await audit();
      await navigate(page, "Create");
      await expect(page.getByLabel("Keywords (comma separated)")).toBeVisible();
      await audit();
      await navigate(page, width < 768 ? "More" : "Account & appearance");
      await expect(page.getByRole("dialog")).toBeVisible();
      await audit();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      for (const path of ["/privacy", "/terms", "/data-deletion"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await audit();
      }
    });
  }
