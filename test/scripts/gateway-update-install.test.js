import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const TMPFILES_PATH = new URL("../../scripts/vera-gateway-update.tmpfiles.conf", import.meta.url);
const ACCESS_DROP_IN_PATH = new URL("../../scripts/vera-gateway-update-access.conf", import.meta.url);

test("updater install artifacts preserve the Gateway privilege boundary", async () => {
  const tmpfiles = await readFile(TMPFILES_PATH, "utf8");
  assert.deepEqual(tmpfiles.trim().split("\n"), [
    "d /var/lib/vera-updater 0710 root vera -",
    "d /var/lib/vera-updater/requests 0750 vera vera -",
    "d /var/lib/vera-updater/status 2750 root vera -",
    "d /var/lib/vera-updater/backups 0700 root root -",
    "d /var/lib/vera-updater/repository 0700 root root -",
    "d /var/lib/vera-updater/npm-cache 0700 root root -",
  ]);

  const accessDropIn = await readFile(ACCESS_DROP_IN_PATH, "utf8");
  assert.equal(accessDropIn, "[Service]\nReadWritePaths=/var/lib/vera-updater/requests\n");
  assert.equal(accessDropIn.includes("/status"), false);
  assert.equal(accessDropIn.includes("/opt/vera"), false);
});
