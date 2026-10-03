export type Measurement = { timestamp: string };

export type CpuMetrics = Measurement & {
  usagePercent: number;
  userPercent: number;
  systemPercent: number;
  idlePercent: number;
  logicalCores: number;
  physicalCores: number | null;
  model: string;
  frequencyMHz: number | null;
  loadAverage: [number, number, number];
  perCore: number[];
};

export type MemoryMetrics = Measurement & {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  freeBytes: number;
  cachedBytes: number;
  usagePercent: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  swapFreeBytes: number;
};

export type DiskMetric = Measurement & { filesystem: string; mountPoint: string; totalBytes: number; usedBytes: number; availableBytes: number; usagePercent: number };

export type GpuMetrics = Measurement & { available: boolean; reason?: string; name?: string; utilizationPercent?: number; vramTotalBytes?: number; vramUsedBytes?: number; vramFreeBytes?: number; temperatureCelsius?: number; powerWatts?: number; driverVersion?: string };

export type TemperatureSensor = { name: string; temperatureCelsius: number; source: string };
export type TemperatureMetrics = Measurement & { available: boolean; sensors: TemperatureSensor[]; reason?: string };

export type NetworkMetric = Measurement & { interface: string; state: string; receivedBytes: number; transmittedBytes: number; receivedRateBytes: number; transmittedRateBytes: number; addresses: string[] };

export type SystemInfo = Measurement & { hostname: string; operatingSystem: string; kernel: string; architecture: string; uptimeSeconds: number; bootTime: string; cpuModel: string; totalMemoryBytes: number };

export type ProcessMetric = { pid: number; name: string; cpuPercent: number; memoryBytes: number; memoryPercent: number; status: string; user: string };
export type ProcessSort = "cpu" | "memory" | "pid" | "name";
export type ProcessPage = Measurement & { items: ProcessMetric[]; page: number; limit: number; total: number; sort: ProcessSort };

export type SystemOverview = Measurement & { system: SystemInfo | null; cpu: CpuMetrics | null; memory: MemoryMetrics | null; disk: DiskMetric[]; gpu: GpuMetrics | null; temperature: TemperatureMetrics | null; network: NetworkMetric[]; errors: Partial<Record<"system" | "cpu" | "memory" | "disk" | "gpu" | "temperature" | "network", string>> };
