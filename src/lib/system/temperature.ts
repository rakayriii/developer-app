import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TemperatureMetrics, TemperatureSensor } from "./types";

export async function getTemperatureMetrics(): Promise<TemperatureMetrics> {
  const sensors: TemperatureSensor[] = [];
  try {
    for (const entry of await readdir("/sys/class/hwmon")) {
      const base = path.join("/sys/class/hwmon", entry);
      let chip = entry;
      try { chip = (await readFile(path.join(base, "name"), "utf8")).trim() || entry; } catch { /* name is optional */ }
      for (const file of await readdir(base)) {
        if (!/^temp\d+_input$/.test(file)) continue;
        try {
          const value = Number((await readFile(path.join(base, file), "utf8")).trim()) / 1000;
          if (!Number.isFinite(value) || value < -100 || value > 200) continue;
          let label = chip;
          try { label = (await readFile(path.join(base, file.replace("_input", "_label")), "utf8")).trim() || chip; } catch { /* label is optional */ }
          sensors.push({ name: label, temperatureCelsius: Math.round(value * 10) / 10, source: path.join("/sys/class/hwmon", entry, file) });
        } catch { /* Sensors can disappear while being read. */ }
      }
    }
  } catch { /* hwmon is not present on every Linux host. */ }
  if (!sensors.length) {
    try { for (const entry of await readdir("/sys/class/thermal")) { if (!entry.startsWith("thermal_zone")) continue; const base = path.join("/sys/class/thermal", entry); const value = Number((await readFile(path.join(base, "temp"), "utf8")).trim()) / 1000; if (Number.isFinite(value)) sensors.push({ name: (await readFile(path.join(base, "type"), "utf8")).trim() || entry, temperatureCelsius: Math.round(value * 10) / 10, source: path.join("/sys/class/thermal", entry) }); } } catch { /* Thermal zones are optional. */ }
  }
  return { timestamp: new Date().toISOString(), available: sensors.length > 0, sensors, reason: sensors.length ? undefined : "Temperature data unavailable" };
}
