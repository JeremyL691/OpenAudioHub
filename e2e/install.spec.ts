import { expect, test } from "@playwright/test";

// The install page is public, and the installer it links to is served as a shell script (F22).
test.use({ storageState: { cookies: [], origins: [] } });

test("the install page offers the installer and a pinned version", async ({
    page,
    request,
}) => {
    await page.goto("/install");
    await expect(
        page.getByRole("heading", { name: "Install OpenAudioHub" }),
    ).toBeVisible();
    await expect(page.getByText("Pin to a specific version")).toBeVisible();

    const installer = await request.get("/install.sh");
    expect(installer.ok()).toBeTruthy();
    expect(installer.headers()["content-type"]).toContain("text/x-shellscript");
    expect(await installer.text()).not.toContain("{{VERSION}}");
});
