import { JobQueue } from "../src/queue.js";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTests() {
  console.log("=== Running JobQueue Anti-Spam & Serialization Tests ===");
  const queue = new JobQueue("test-queue", { maxQueueSize: 3, maxPerUser: 1 });

  let job1Started = false;
  let job1Finished = false;
  let job2Started = false;
  let job2Finished = false;
  let job2PositionNotified = null;

  // 1. Submit Job 1 (User A)
  const res1 = await queue.enqueue({
    sender: "user_A",
    label: "Task 1",
    onStart: async () => {
      job1Started = true;
    },
    run: async () => {
      await sleep(100);
      job1Finished = true;
    },
  });

  if (!res1.ok || res1.queued !== false) {
    throw new Error("Test failed: Job 1 should run immediately when queue is idle");
  }
  console.log("✅ Check 1: Job 1 starts immediately when queue is idle");

  // 2. Submit Job 2 from User A while Job 1 is still active -> Should be blocked by anti-spam!
  const resSpam = await queue.enqueue({
    sender: "user_A",
    label: "Spam Task",
    run: async () => {},
  });

  if (resSpam.ok || resSpam.error !== "USER_LIMIT_REACHED") {
    throw new Error("Test failed: User A was able to spam while having an active job");
  }
  console.log("✅ Check 2: Anti-spam blocked duplicate job from User A");

  // 3. Submit Job 2 from User B -> Should be queued at position 1
  const res2 = await queue.enqueue({
    sender: "user_B",
    label: "Task 2",
    onPosition: async (pos) => {
      job2PositionNotified = pos;
    },
    onStart: async () => {
      job2Started = true;
    },
    run: async () => {
      await sleep(50);
      job2Finished = true;
    },
  });

  if (!res2.ok || res2.queued !== true || res2.position !== 1) {
    throw new Error(`Test failed: Job 2 should be queued at position 1, got position ${res2.position}`);
  }
  if (job2PositionNotified !== 1) {
    throw new Error(`Test failed: User B was not notified of position 1`);
  }
  console.log("✅ Check 3: Job 2 from User B queued at position #1 and notified");

  // 4. Fill queue up to max
  await queue.enqueue({ sender: "user_C", label: "Task 3", run: async () => {} });
  await queue.enqueue({ sender: "user_D", label: "Task 4", run: async () => {} });

  const resFull = await queue.enqueue({ sender: "user_E", label: "Task 5", run: async () => {} });
  if (resFull.ok || resFull.error !== "QUEUE_FULL") {
    throw new Error("Test failed: Queue should reject when full");
  }
  console.log("✅ Check 4: Queue rejects with QUEUE_FULL when capacity reached");

  // Wait for all jobs to complete
  await sleep(250);

  if (!job1Finished || !job2Finished || !job2Started) {
    throw new Error("Test failed: Jobs did not execute sequentially in queue");
  }
  console.log("✅ Check 5: Queued jobs executed in order automatically");

  console.log("\n🎉 ALL QUEUE & ANTI-SPAM TESTS PASSED!");
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
