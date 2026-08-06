import { expect, test } from "@playwright/test"
test("middle click opens a new tab", async ({ page, context }) => {
  await page.goto("/")
  const link = page.getByRole("link", { name: "Open target" })
  const href = (await link.getAttribute("href")) as string
  expect(href).toBe("/target.html")
  const newTab = context.waitForEvent("page")
  await link.click({ button: "middle" })
  await (await newTab).waitForURL(`**${href}`)
})
test("modifier click opens a new tab", async ({ page, context }) => {
  await page.goto("/")
  const link = page.getByRole("link", { name: "Open target" })
  const href = (await link.getAttribute("href")) as string
  expect(href).toBe("/target.html")
  const newTab = context.waitForEvent("page")
  await link.click({ modifiers: ["ControlOrMeta"] })
  await (await newTab).waitForURL(`**${href}`)
})
