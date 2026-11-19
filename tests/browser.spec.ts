import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { makePool, migrate } from "../src/server/db.js";
import { buildApp } from "../src/server/app.js";
import { passwordHash, token, hash } from "../src/server/crypto.js";
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw new Error("Dedicated TEST_DATABASE_URL ending in _test required");
const pool = makePool(url),
  eventId = randomUUID(),
  password = randomBytes(24).toString("base64url");
const staffId = randomUUID(),
  vendorUser = randomUUID(),
  otherUser = randomUUID(),
  vendorA = randomUUID(),
  vendorB = randomUUID();
let app: Awaited<ReturnType<typeof buildApp>>;
const cameraToken = token(),
  cameraCredential = randomUUID();
test.beforeAll(async () => {
  await migrate(pool);
  await pool.query("INSERT INTO events(id,name) VALUES ($1,$2)", [
    eventId,
    "活動 QR 驗收測試",
  ]);
  for (const [id, role] of [
    [staffId, "EVENT_STAFF"],
    [vendorUser, "VENDOR"],
    [otherUser, "VENDOR"],
  ])
    await pool.query(
      "INSERT INTO staff_users(id,email,password_hash,role) VALUES ($1,$2,$3,$4)",
      [id, id + "@test.invalid", passwordHash(password), role],
    );
  await pool.query(
    "INSERT INTO vendors(id,event_id,name) VALUES ($1,$3,$4),($2,$3,$5)",
    [vendorA, vendorB, eventId, "A 攤｜咖啡飲品", "B 攤｜特色點心"],
  );
  await pool.query(
    "INSERT INTO vendor_staff_assignments VALUES ($1,$2),($3,$4)",
    [vendorUser, vendorA, otherUser, vendorB],
  );
  app = await buildApp(
    {
      databaseUrl: url,
      eventId,
      origin: "http://localhost:5173",
      printKey: randomBytes(32).toString("hex"),
      production: false,
    },
    pool,
  );
  await app.listen({ host: "127.0.0.1", port: 3000 });
  await mkdir(".local/screenshots", { recursive: true });
  const batchId = randomUUID();
  await pool.query(
    "INSERT INTO qr_batches(id,event_id,name,quantity,created_by) VALUES ($1,$2,$3,1,$4)",
    [batchId, eventId, "相機驗證批次", staffId],
  );
  await pool.query(
    "INSERT INTO credentials(id,event_id,batch_id,public_code,token_hash) VALUES ($1,$2,$3,$4,$5)",
    [
      cameraCredential,
      eventId,
      batchId,
      "CAMERA-" + randomUUID().slice(0, 16),
      hash(cameraToken),
    ],
  );
  const qr = PNG.sync.read(
    await QRCode.toBuffer("EVTQR:" + cameraToken, { width: 200, margin: 4 }),
  );
  const y = Buffer.alloc(640 * 480, 235),
    chroma = Buffer.alloc((640 * 480) / 2, 128);
  for (let row = 0; row < qr.height; row++)
    for (let col = 0; col < qr.width; col++)
      y[(row + 140) * 640 + col + 220] = Math.round(
        16 + (qr.data[(row * qr.width + col) * 4] * 219) / 255,
      );
  await writeFile(
    ".local/camera.y4m",
    Buffer.concat([
      Buffer.from("YUV4MPEG2 W640 H480 F10:1 Ip A1:1 C420jpeg\n"),
      ...Array.from({ length: 20 }, () =>
        Buffer.concat([Buffer.from("FRAME\n"), y, chroma]),
      ),
    ]),
  );
});
test.afterAll(async () => {
  await app?.close();
  await pool.end();
});
test("實體QR批次列印 → 工作人員啟用 → A攤核銷 → B攤拒絕 → 後台統計", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  async function login(id: string) {
    await page.getByLabel("電子郵件").fill(id + "@test.invalid");
    await page.getByLabel("密碼", { exact: true }).fill(password);
    await page.getByRole("button", { name: "登入", exact: true }).click();
  }
  await page.goto("/");
  await login(staffId);
  await expect(
    page.getByRole("heading", { name: "活動管理儀表板" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "QR 批次", exact: true }).click();
  await page.getByLabel("批次名稱").fill("活動第一批");
  await page.getByLabel("預計產生數量").fill("3");
  await page.getByRole("button", { name: "建立可列印 QR 批次" }).click();
  await expect(page.getByText("3 張憑證", { exact: false })).toBeVisible();
  await page
    .locator(".batch-row")
    .filter({ hasText: "活動第一批" })
    .getByRole("button", { name: "列印", exact: true })
    .click();
  await expect(page.locator(".print-card")).toHaveCount(3);
  await expect(page.locator(".print-card img").first()).toHaveJSProperty(
    "complete",
    true,
  );
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".print-toolbar")).toBeHidden();
  await expect(page.locator(".print-card").first()).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  // Read the QR payload using the same authenticated print endpoint; never write raw tokens to disk.
  const batchList = await (
    await page.request.get("/api/admin/qr-batches")
  ).json();
  const printed = await (
    await page.request.get(
      `/api/admin/qr-batches/${batchList.items.find((b: any) => b.name === "活動第一批").id}/print`,
    )
  ).json();
  await page.getByRole("button", { name: "關閉列印" }).click();
  await page.getByRole("button", { name: "入場啟用", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "入場憑證啟用" }),
  ).toBeVisible();
  await page.getByLabel("完整憑證輸入").fill(printed.cards[0].qrContent);
  await page.getByRole("button", { name: "確認啟用入場" }).click();
  await expect(page.getByText("啟用序號 1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已取得免費兌換資格", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "掃描下一張" }).click();
  await page.screenshot({
    path: ".local/screenshots/staff.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await login(vendorUser);
  await page.getByLabel("完整憑證輸入").fill(printed.cards[0].qrContent);
  await page.getByRole("button", { name: "檢查兌換資格" }).click();
  await expect(
    page.getByRole("heading", { name: "可免費兌換", exact: true }),
  ).toBeVisible();
  const count = (
    await pool.query(
      "SELECT count(*)::int AS n FROM redemptions WHERE event_id=$1",
      [eventId],
    )
  ).rows[0].n;
  expect(count).toBe(0);
  await page.getByRole("button", { name: "確認交付並核銷" }).click();
  await expect(page.getByRole("heading", { name: "核銷成功" })).toBeVisible();
  await page.getByRole("button", { name: "掃描下一張" }).click();
  await page.screenshot({
    path: ".local/screenshots/vendor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await login(otherUser);
  await page.getByLabel("完整憑證輸入").fill(printed.cards[0].qrContent);
  await page.getByRole("button", { name: "檢查兌換資格" }).click();
  await expect(page.getByRole("heading", { name: "無法兌換" })).toBeVisible();
  await expect(
    page.getByText("這張免費資格已使用", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "確認交付並核銷" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "登出", exact: true }).click();
  await login(staffId);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(
    page.getByRole("heading", { name: "活動管理儀表板" }),
  ).toBeVisible();
  await expect(
    page.locator(".metric").filter({ hasText: "成功兌換" }).locator("strong"),
  ).toHaveText("1");
  await page.screenshot({
    path: ".local/screenshots/admin.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "攤販統計", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(2);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "匯出核銷 CSV" }).click();
  expect((await download).suggestedFilename()).toBe("redemptions.csv");
  expect(errors).toEqual([]);
});
test("相機掃描實際 QR 影像、關閉鏡頭後啟用", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      try {
        return await original(constraints);
      } catch (error) {
        (window as any).cameraDiagnostic = String(error);
        throw error;
      }
    };
  });
  await page.getByLabel("電子郵件").fill(staffId + "@test.invalid");
  await page.getByLabel("密碼", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.getByRole("button", { name: "入場啟用", exact: true }).click();
  await page.getByRole("button", { name: "開啟相機掃描" }).click();
  await expect
    .poll(
      async () => {
        const error = await page
          .locator(".modal [role=alert]")
          .textContent({ timeout: 100 })
          .catch(() => null);
        if (error)
          throw new Error(
            error +
              " " +
              (await page.evaluate(
                () =>
                  (window as any).cameraDiagnostic ??
                  "media request did not reject",
              )),
          );
        return (await page.getByLabel("完整憑證輸入").inputValue()).length;
      },
      { timeout: 15000 },
    )
    .toBe(43);
  await expect(page.locator(".camera-view")).toHaveCount(0);
  await page.getByRole("button", { name: "確認啟用入場" }).click();
  await expect(
    page.getByText("已取得免費兌換資格", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await pool.query("SELECT status FROM credentials WHERE id=$1", [
        cameraCredential,
      ])
    ).rows[0].status,
  ).toBe("ACTIVATED");
});
