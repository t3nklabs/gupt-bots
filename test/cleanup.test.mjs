import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";

import { deleteOldBotFiles } from "../src/cleanup.js";

test("deletes bot files older than 30 days and keeps newer ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "gupt-cleanup-"));
  const oldDir = join(root, "youtube", "job-old");
  const newDir = join(root, "youtube", "job-new");
  await mkdir(oldDir, { recursive: true });
  await mkdir(newDir, { recursive: true });
  const oldFile = join(oldDir, "track.m4a");
  const newFile = join(newDir, "track.m4a");
  await writeFile(oldFile, "old");
  await writeFile(newFile, "new");

  const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, stale, stale);
  await utimes(oldDir, stale, stale);

  const removed = await deleteOldBotFiles(root);
  assert.ok(removed >= 1);
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(newFile), true);
});
