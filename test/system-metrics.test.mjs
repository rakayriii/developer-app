import assert from "node:assert/strict";
import { test } from "node:test";
import { getCpuMetrics } from "../src/lib/system/cpu.ts";
import { getDiskMetrics } from "../src/lib/system/disk.ts";
import { getGpuMetrics } from "../src/lib/system/gpu.ts";
import { getMemoryMetrics } from "../src/lib/system/memory.ts";
import { getNetworkMetrics } from "../src/lib/system/network.ts";
import { getProcessMetrics } from "../src/lib/system/processes.ts";
import { getTemperatureMetrics } from "../src/lib/system/temperature.ts";

test("CPU measurements stay within valid ranges", async () => {
  await getCpuMetrics();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cpu = await getCpuMetrics();
  assert.ok(cpu.logicalCores > 0);
  assert.ok(cpu.usagePercent >= 0 && cpu.usagePercent <= 100);
  assert.equal(cpu.perCore.length, cpu.logicalCores);
});

test("memory metrics use Linux available-memory semantics", async () => {
  const memory = await getMemoryMetrics();
  assert.ok(memory.totalBytes > 0);
  assert.ok(memory.availableBytes >= 0 && memory.availableBytes <= memory.totalBytes);
  assert.ok(memory.usedBytes >= 0 && memory.usedBytes <= memory.totalBytes);
  assert.ok(memory.usagePercent >= 0 && memory.usagePercent <= 100);
});

test("disk metrics contain only safe enumerated mounts", async () => {
  const disks = await getDiskMetrics();
  assert.ok(disks.length > 0);
  for (const disk of disks) { assert.ok(disk.mountPoint.startsWith("/")); assert.ok(disk.totalBytes > 0); assert.ok(disk.availableBytes >= 0); assert.ok(disk.usagePercent >= 0 && disk.usagePercent <= 100); }
});

test("GPU absence is represented as partial availability", async () => {
  const gpu = await getGpuMetrics();
  assert.equal(typeof gpu.available, "boolean");
  if (!gpu.available) assert.ok(gpu.reason);
});

test("process sorting and limit are enforced", async () => {
  const processes = await getProcessMetrics("memory", 1, 3);
  assert.ok(processes.items.length <= 3);
  assert.equal(processes.limit, 3);
  for (let index = 1; index < processes.items.length; index += 1) assert.ok(processes.items[index - 1].memoryBytes >= processes.items[index].memoryBytes);
});

test("network rates never become negative", async () => {
  await getNetworkMetrics();
  const network = await getNetworkMetrics();
  for (const item of network) { assert.ok(item.receivedRateBytes >= 0); assert.ok(item.transmittedRateBytes >= 0); }
});

test("temperature provider handles missing sensors without fake values", async () => {
  const temperature = await getTemperatureMetrics();
  assert.equal(typeof temperature.available, "boolean");
  if (!temperature.available) assert.equal(temperature.reason, "Temperature data unavailable");
});
