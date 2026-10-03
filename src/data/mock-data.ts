export const projects: { name: string; status: string; framework: string; repo: string; updated: string; tone: string }[] = [];

export const systemMetrics = [
  { label: "CPU usage", value: "42%", width: "42%", detail: "8 cores available", tone: "blue" },
  { label: "RAM usage", value: "61%", width: "61%", detail: "9.8 GB of 16 GB", tone: "green" },
  { label: "GPU usage", value: "18%", width: "18%", detail: "2.1 GB of 12 GB", tone: "blue" },
  { label: "Disk usage", value: "73%", width: "73%", detail: "438 GB of 600 GB", tone: "yellow" },
  { label: "Network", value: "38 MB/s", width: "38%", detail: "Down 31 MB/s, up 7 MB/s", tone: "green" },
];
